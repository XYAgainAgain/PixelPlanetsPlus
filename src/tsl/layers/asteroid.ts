import { Mesh, MeshBasicNodeMaterial, PlaneGeometry, Vector4 } from 'three/webgpu'
import {
    Fn, If, distance, float, floor, fract, length, smoothstep, step, uniform, vec2, vec4,
} from 'three/tsl'
import { ditherCheck, makeFbm, makeRand, pixelize, planetUv, rotateUv } from '../common'
import type { NV2, UF, UV2 } from '../common'
import type { LayerValues } from '../values'

/* Asteroids.gdshader: no spherify, no circle cutout — the silhouette IS the stepped noise.
   Spin comes from the rotation uniform (set_custom_time drives rotation = t·2π), never time. */

export interface AsteroidSharedUniforms {
    pixels: UF
    rotation: UF
    lightOrigin: UV2
    seed: UF
}

export const createAsteroidUniforms = (v: LayerValues, shared: AsteroidSharedUniforms) => ({
    ...shared,
    // Float 0/1 stand-in for Godot's bool uniform; the toggle writes 1 or 0
    shouldDither: uniform(v.shouldDither === false ? 0.0 : 1.0),
    colors: v.colors.map((c) => uniform(new Vector4(...c))),
})
export type AsteroidUniforms = ReturnType<typeof createAsteroidUniforms>

export const createAsteroidLayer = (v: LayerValues, u: AsteroidUniforms): Mesh => {
    const spec = v.noise ?? { hash: 15.5453, tiling: 'none' as const }
    const fbm = makeFbm(v.octaves ?? 2, spec)
    const rand = makeRand(spec)
    const size = float(v.size ?? 5.294)

    /* Local Leukbaars variant: hard 0.9r–r crater rim instead of the clouds' 0–r ramp,
       so it stays here rather than in common.ts. */
    const circleNoise = Fn(([uvIn]: [NV2]) => {
        const uv = vec2(uvIn).toVar()
        const uvY = floor(uv.y).toVar()
        uv.assign(vec2(uv.x.add(uvY.mul(0.31)), uv.y))
        const f = fract(uv)
        const h = rand(vec2(floor(uv.x), uvY), u.seed, size)
        const m = length(f.sub(0.25).sub(h.mul(0.5)))
        // h hits exactly 0 in rare cells; epsilon dodges WGSL's undefined smoothstep(0,0,x)
        const r = h.mul(0.25).max(0.000001)
        return smoothstep(r.sub(r.mul(0.10)), r, m)
    })

    const crater = Fn(([uvIn]: [NV2]) => {
        const c = float(1.0).toVar()
        // Godot's 2-iteration loop unrolled: offsets float(i+1)+10.0 are 11 and 12
        c.mulAssign(circleNoise(uvIn.mul(size).add(11.0)))
        c.mulAssign(circleNoise(uvIn.mul(size).add(12.0)))
        return float(1.0).sub(c)
    })

    const fragment = Fn(() => {
        // Pre-mutation reads frozen with .toVar(); see planetUnder.ts for the TSL gotcha
        const raw = planetUv().toVar()
        const uv = pixelize(raw, u.pixels).toVar()
        const dith = ditherCheck(uv, raw, u.pixels).toVar()
        const d = distance(uv, vec2(0.5)).toVar()

        uv.assign(rotateUv(uv, u.rotation))

        const n = fbm(uv.mul(size), u.seed, size).toVar()
        // The shadow probe: noise re-sampled offset toward the rotated light direction
        const n2 = fbm(
            uv.mul(size).add(rotateUv(u.lightOrigin, u.rotation).sub(0.5).mul(0.5)),
            u.seed, size).toVar()

        // Silhouette cutoff loosens toward the center (d is distance from disc center)
        const nStep = step(0.2, n.sub(d)).toVar()
        const n2Step = step(0.2, n2.sub(d)).toVar()
        const noiseRel = n2Step.add(n2).sub(nStep.add(n)).toVar()

        const c1 = crater(uv).toVar()
        const c2 = crater(uv.add(u.lightOrigin.sub(0.5).mul(0.03))).toVar()

        // Godot's (dith || !should_dither): off widens the shade band, not just the checker
        const ditherPass = dith.or(u.shouldDither.lessThan(0.5))
        const col = vec4(u.colors[1]).toVar()
        If(noiseRel.lessThan(-0.06).or(noiseRel.lessThan(-0.04).and(ditherPass)), () => {
            col.assign(u.colors[0])
        })
        If(noiseRel.greaterThan(0.05).or(noiseRel.greaterThan(0.03).and(ditherPass)), () => {
            col.assign(u.colors[2])
        })
        If(c1.greaterThan(0.4), () => {
            col.assign(u.colors[1])
        })
        If(c2.lessThan(c1), () => {
            col.assign(u.colors[2])
        })

        return vec4(col.xyz, nStep.mul(col.w))
    })

    const material = new MeshBasicNodeMaterial({ transparent: true })
    material.fragmentNode = fragment()
    return new Mesh(new PlaneGeometry(1, 1), material)
}
