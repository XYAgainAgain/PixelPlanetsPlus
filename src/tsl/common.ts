import {
    Fn, Loop, float, vec2, floor, fract, sin, dot, mix, mod, sqrt, step,
    length, smoothstep, cos, min, positionGeometry,
} from 'three/tsl'
import type { Node, UniformNode, Vector2 as V2, Vector4 as V4 } from 'three/webgpu'

/* Generic node handles: every concrete TSL node assigns to Node<"type"> */
export type NF = Node<'float'>
export type NV2 = Node<'vec2'>

/* Uniform handles for layer uniform bundles, matching what uniform() returns */
export type UF = UniformNode<'float', number>
export type UV2 = UniformNode<'vec2', V2>
export type UV4 = UniformNode<'vec4', V4>

/* All helpers are line-for-line ports of the Godot shaders at
   .dev/refs/PixelPlanets-godot/. Godot values are canonical; do not "improve" them. */

/* Godot's UV space: y-down, [0,1] across a PlaneGeometry(1,1) quad, so every .tscn value
   (light_origin, rotation, droop) applies verbatim. Oversized layers (rings ×3, star blobs ×2)
   use mesh.scale so UV stays [0,1] across the whole extent, exactly like Godot's ColorRects;
   only the atmosphere's overhang geometry deliberately runs past [0,1]. */
export const planetUv = Fn(() => {
    return vec2(positionGeometry.x.add(0.5), float(0.5).sub(positionGeometry.y))
})

// Godot quantizes with no +0.5, keeping the grid symmetric about disc center (S11)
export const pixelize = Fn(([uv, pixels]: [NV2, NF]) => {
    return floor(uv.mul(pixels)).div(pixels)
})

/* How rand() wraps its lattice: 'planet' fakes a far side via vec2(2,1)*round(size),
   'simple' wraps square, 'none' never tiles (only Galaxy and Asteroid). */
export type NoiseTiling = 'planet' | 'simple' | 'none'
export interface NoiseSpec {
    // 15.5453 everywhere except Terran Dry and the Ice World lakes, which use 43758.5453
    hash: number
    tiling: NoiseTiling
}

// floor(size+0.5), because WGSL round() is round-half-even and Godot's round() is half-up
const roundedSize = (size: NF): NF => floor(size.add(0.5))

export const makeRand = (spec: NoiseSpec) => Fn(([coord, seed, size]: [NV2, NF, NF]) => {
    const c = spec.tiling === 'none'
        ? vec2(coord)
        : spec.tiling === 'planet'
            ? mod(coord, vec2(2.0, 1.0).mul(roundedSize(size)))
            : mod(coord, vec2(1.0, 1.0).mul(roundedSize(size)))
    return fract(sin(dot(c.xy, vec2(12.9898, 78.233))).mul(spec.hash).mul(seed))
})

export const makeValueNoise = (spec: NoiseSpec) => {
    const rand = makeRand(spec)
    return Fn(([coord, seed, size]: [NV2, NF, NF]) => {
        const i = floor(coord)
        const f = fract(coord)
        const a = rand(i, seed, size)
        const b = rand(i.add(vec2(1.0, 0.0)), seed, size)
        const c = rand(i.add(vec2(0.0, 1.0)), seed, size)
        const d = rand(i.add(vec2(1.0, 1.0)), seed, size)
        const cubic = f.mul(f).mul(float(3.0).sub(f.mul(2.0)))
        return mix(a, b, cubic.x)
            .add(c.sub(a).mul(cubic.y).mul(float(1.0).sub(cubic.x)))
            .add(d.sub(b).mul(cubic.x).mul(cubic.y))
    })
}

/* Octave count is compile-time (the values table drives it); Godot's OCTAVES uniform
   only ever holds the scene-tuned constant anyway. */
export const makeFbm = (octaves: number, spec: NoiseSpec) => {
    const noise = makeValueNoise(spec)
    return Fn(([coord, seed, size]: [NV2, NF, NF]) => {
        const value = float(0.0).toVar()
        const co = vec2(coord).toVar()
        const scale = float(0.5).toVar()
        Loop(octaves, () => {
            value.addAssign(noise(co, seed, size).mul(scale))
            co.mulAssign(2.0)
            scale.mulAssign(0.5)
        })
        return value
    })
}

/* The Leukbaars circle noise shared by the cloud and gas shaders. Craters and StarBlobs
   carry their own variants; those stay local to their layers. */
export const makeCircleNoise = (spec: NoiseSpec) => {
    const rand = makeRand(spec)
    return Fn(([uvIn, seed, size]: [NV2, NF, NF]) => {
        const uv = vec2(uvIn).toVar()
        const uvY = floor(uv.y).toVar()
        uv.assign(vec2(uv.x.add(uvY.mul(0.31)), uv.y))
        const f = fract(uv)
        const h = rand(vec2(floor(uv.x), uvY), seed, size)
        const m = length(f.sub(0.25).sub(h.mul(0.5)))
        // h hits exactly 0 in 1 of size² cells; epsilon dodges WGSL's undefined smoothstep(0,0,x)
        const r = h.mul(0.25).max(0.000001)
        return smoothstep(0.0, r, m.mul(0.75))
    })
}

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

export const posterize = Fn(([value, steps]: [NF, NF]) => {
    return floor(value.mul(steps)).div(steps)
})

// Godot clamps its posterize chains (DryTerran.tscn:118, Ring.gdshader:109); never drop the min
export const posterizeClamp = Fn(([value, steps, maxVal]: [NF, NF, NF]) => {
    return min(floor(value.mul(steps)).div(steps), maxVal)
})

// The BlackHoleRing.gdshader:150–152 form: a clamped integer palette index
export const posterizeIndex = Fn(([value, nMinus1]: [NF, NF]) => {
    return min(floor(value.mul(nMinus1)), nMinus1)
})

/* Planet.gd:25–26. Shaders scroll by time·time_speed, so driving time = t·multiplier·k
   cancels time_speed and loops the noise over one whole size period (seamless GIF loop). */
export const getMultiplier = (size: number, timeSpeed: number): number =>
    (Math.round(size) * 2) / timeSpeed

// GasPlanetLayers.gd:38 and BlackHole.gd update_time drive ring/disk time as t·314.15·0.004
export const RING_TIME_MULT = 314.15 * 0.004
