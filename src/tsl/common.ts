import {
    Fn, Loop, float, vec2, floor, fract, sin, dot, mix, mod, sqrt, step,
    length, smoothstep, cos,
} from 'three/tsl'
import type { Node } from 'three/webgpu'

/* Generic node handles: every concrete TSL node assigns to Node<"type"> */
export type NF = Node<'float'>
export type NV2 = Node<'vec2'>

/* All helpers are faithful ports of the upstream GLSL: same constants, same operation
   order. The pixel-art look lives in these exact formulas; do not "improve" them. */

export const pixelize = Fn(([p, pixels]: [NV2, NF]) => {
    return floor(p.mul(pixels)).div(pixels).add(0.5)
})

export const rand2 = Fn(([coord, seed, size]: [NV2, NF, NF]) => {
    const c = mod(coord, vec2(floor(size.add(0.5))))
    return fract(sin(dot(c.xy, vec2(12.9898, 78.233))).mul(15.5453).mul(seed))
})

export const valueNoise = Fn(([coord, seed, size]: [NV2, NF, NF]) => {
    const i = floor(coord)
    const f = fract(coord)
    const a = rand2(i, seed, size)
    const b = rand2(i.add(vec2(1.0, 0.0)), seed, size)
    const c = rand2(i.add(vec2(0.0, 1.0)), seed, size)
    const d = rand2(i.add(vec2(1.0, 1.0)), seed, size)
    const cubic = f.mul(f).mul(float(3.0).sub(f.mul(2.0)))
    return mix(a, b, cubic.x)
        .add(c.sub(a).mul(cubic.y).mul(float(1.0).sub(cubic.x)))
        .add(d.sub(b).mul(cubic.x).mul(cubic.y))
})

/* Octave count is a compile-time constant per layer (20 base, 6 land, 4 clouds) */
export const makeFbm = (octaves: number) => Fn(([coord, seed, size]: [NV2, NF, NF]) => {
    const value = float(0.0).toVar()
    const co = vec2(coord).toVar()
    const scale = float(0.5).toVar()
    Loop(octaves, () => {
        value.addAssign(valueNoise(co, seed, size).mul(scale))
        co.mulAssign(2.0)
        scale.mulAssign(0.5)
    })
    return value
})

/* True on the checkerboard texel, the signature dither at every light-band boundary */
export const ditherCheck = Fn(([uvPixel, uvReal, pixels]: [NV2, NV2, NF]) => {
    return mod(uvPixel.x.add(uvReal.y), float(2.0).div(pixels)).lessThanEqual(float(1.0).div(pixels))
})

export const rotateUv = Fn(([coord, angle]: [NV2, NF]) => {
    const c = coord.sub(0.5)
    const x = c.x.mul(cos(angle)).sub(c.y.mul(sin(angle)))
    const y = c.x.mul(sin(angle)).add(c.y.mul(cos(angle)))
    return vec2(x, y).add(0.5)
})

/* Fake limb projection bulges flat noise outward so a quad reads as a sphere */
export const spherify = Fn(([uv]: [NV2]) => {
    const centered = uv.mul(2.0).sub(1.0)
    const z = sqrt(float(1.0).sub(dot(centered.xy, centered.xy)))
    return centered.div(z.add(1.0)).mul(0.5).add(0.5)
})

/* 0.49999, not 0.5: exactly 0.5 makes edge pixels buggy (upstream comment, verified) */
export const circleCutout = Fn(([uv]: [NV2]) => {
    return step(length(uv.sub(vec2(0.5))), 0.49999)
})

export const circleNoise = Fn(([uvIn, seed, size]: [NV2, NF, NF]) => {
    const uv = vec2(uvIn).toVar()
    const uvY = floor(uv.y).toVar()
    uv.assign(vec2(uv.x.add(uvY.mul(0.31)), uv.y))
    const f = fract(uv)
    const h = rand2(vec2(floor(uv.x), uvY), seed, size)
    const m = length(f.sub(0.25).sub(h.mul(0.5)))
    // h hits exactly 0 in 1 of size² cells; epsilon dodges WGSL's undefined smoothstep(0,0,x)
    const r = h.mul(0.25).max(0.000001)
    return smoothstep(0.0, r, m.mul(0.75))
})
