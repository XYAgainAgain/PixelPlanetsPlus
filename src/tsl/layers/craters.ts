import { Mesh, MeshBasicNodeMaterial, PlaneGeometry, Vector4 } from 'three/webgpu'
import { Fn, If, distance, float, floor, fract, length, smoothstep, step, uniform, vec2, vec4 } from 'three/tsl'
import { circleCutout, makeRand, pixelize, planetUv, rotateUv, spherify } from '../common'
import type { NF, NV2, UF, UV2 } from '../common'
import type { LayerValues } from '../values'

/* NoAtmosphere/Craters.gdshader: pockmarks over the ground on No atmosphere and Lava World.
   Statement order follows the Godot fragment so reviews can diff line-by-line. */

export interface CratersSharedUniforms {
    rotation: UF
    lightOrigin: UV2
    seed: UF
}

export const createCratersUniforms = (v: LayerValues, shared: CratersSharedUniforms) => ({
    ...shared,
    // Own pixels uniform: the scene tunes craters coarser than the ground (87.419 vs 100)
    pixels: uniform(v.pixels),
    time: uniform(0.0),
    lightBorder: uniform(v.lightBorder ?? 0.465),
    colors: v.colors.map((c) => uniform(new Vector4(...c))),
})
export type CratersUniforms = ReturnType<typeof createCratersUniforms>

export const createCratersLayer = (v: LayerValues, u: CratersUniforms): Mesh => {
    const rand = makeRand(v.noise ?? { hash: 15.5453, tiling: 'simple' })
    const size = float(v.size ?? 5.0)
    const timeSpeed = float(v.timeSpeed ?? 0.001)
    const rotationOffset = v.rotationOffset ?? 0.0

    // Craters' own circleNoise variant: smoothstep(0.9r, r, m), not the clouds form in common.ts
    const circleNoise = Fn(([uvIn, seed, sz]: [NV2, NF, NF]) => {
        const uv = vec2(uvIn).toVar()
        const uvY = floor(uv.y).toVar()
        uv.assign(vec2(uv.x.add(uvY.mul(0.31)), uv.y))
        const f = fract(uv)
        const h = rand(vec2(floor(uv.x), uvY), seed, sz)
        const m = length(f.sub(0.25).sub(h.mul(0.5)))
        // h hits exactly 0 in some cells; epsilon dodges WGSL's undefined smoothstep(0,0,x)
        const r = h.mul(0.25).max(0.000001)
        return smoothstep(r.sub(r.mul(0.10)), r, m)
    })

    // Godot's crater(): fixed 2-iteration product, offsets +11 and +12, unrolled here
    const crater = Fn(([uvIn, seed, sz, t]: [NV2, NF, NF, NF]) => {
        const c = float(1.0).toVar()
        c.mulAssign(circleNoise(uvIn.mul(sz).add(11.0).add(vec2(t, 0.0)), seed, sz))
        c.mulAssign(circleNoise(uvIn.mul(sz).add(12.0).add(vec2(t, 0.0)), seed, sz))
        return float(1.0).sub(c)
    })

    const fragment = Fn(() => {
        // Pre-mutation reads frozen with .toVar(); see planetUnder.ts for the TSL gotcha
        const raw = planetUv().toVar()
        const uv = pixelize(raw, u.pixels).toVar()
        const dLight = distance(uv, u.lightOrigin).toVar()
        const alpha = circleCutout(uv).toVar()

        uv.assign(rotateUv(uv, u.rotation.add(rotationOffset)))
        uv.assign(spherify(uv))

        const t = u.time.mul(timeSpeed).toVar()
        const c1 = crater(uv, u.seed, size, t).toVar()
        // Shadow copy offset by (light_origin - 0.5) * 0.03 (the JS port drifted to 0.04)
        const c2 = crater(uv.add(u.lightOrigin.sub(0.5).mul(0.03)), u.seed, size, t).toVar()

        const col = vec4(u.colors[0]).toVar()
        alpha.mulAssign(step(0.5, c1))
        If(c2.lessThan(c1.sub(float(0.5).sub(dLight).mul(2.0))), () => { col.assign(u.colors[1]) })
        If(dLight.greaterThan(u.lightBorder), () => { col.assign(u.colors[1]) })

        return vec4(col.xyz, alpha.mul(col.w))
    })

    const material = new MeshBasicNodeMaterial({ transparent: true })
    material.fragmentNode = fragment()
    return new Mesh(new PlaneGeometry(1, 1), material)
}
