import { Mesh, MeshBasicNodeMaterial, PlaneGeometry, Vector4 } from 'three/webgpu'
import { Fn, If, distance, float, uniform, vec2, vec4 } from 'three/tsl'
import { circleCutout, ditherCheck, makeFbm, pixelize, planetUv, rotateUv } from '../common'
import type { UF, UV2 } from '../common'
import type { LayerValues } from '../values'

/* NoAtmosphere/NoAtmosphere.gdshader: the flat (never spherified) domain-warped ground under
   No atmosphere and Lava World. Statement order follows the Godot fragment. */

export interface GroundSharedUniforms {
    pixels: UF
    rotation: UF
    lightOrigin: UV2
    seed: UF
}

export const createGroundUniforms = (v: LayerValues, shared: GroundSharedUniforms) => ({
    ...shared,
    time: uniform(0.0),
    lightBorder1: uniform(v.lightBorder1 ?? 0.4),
    lightBorder2: uniform(v.lightBorder2 ?? 0.6),
    ditherSize: uniform(v.ditherSize ?? 2.0),
    // Float 0/1 stand-in for Godot's bool uniform; the toggle writes 1 or 0
    shouldDither: uniform(v.shouldDither === false ? 0.0 : 1.0),
    // Deep-Fold's inline 0.3 "magic light strength", promoted to a knob at the same default
    lightIntensity: uniform(0.3),
    colors: v.colors.map((c) => uniform(new Vector4(...c))),
})
export type GroundUniforms = ReturnType<typeof createGroundUniforms>

export const createGroundLayer = (v: LayerValues, u: GroundUniforms): Mesh => {
    const fbm = makeFbm(v.octaves ?? 4, v.noise ?? { hash: 15.5453, tiling: 'simple' })
    const size = float(v.size ?? 8.0)
    const timeSpeed = float(v.timeSpeed ?? 0.4)

    const fragment = Fn(() => {
        // Pre-mutation reads frozen with .toVar(); see planetUnder.ts for the TSL gotcha
        const raw = planetUv().toVar()
        const uv = pixelize(raw, u.pixels).toVar()
        const dLight = distance(uv, u.lightOrigin).toVar()
        const alpha = circleCutout(uv).toVar()
        const dith = ditherCheck(uv, raw, u.pixels).toVar()

        uv.assign(rotateUv(uv, u.rotation))

        // The unscaled fbm warps the scaled one: Godot's "moving dynamic shape"
        const fbm1 = fbm(uv, u.seed, size)
        dLight.addAssign(
            fbm(uv.mul(size).add(fbm1).add(vec2(u.time.mul(timeSpeed), 0.0)), u.seed, size)
                .mul(u.lightIntensity))

        const ditherBorder = float(1.0).div(u.pixels).mul(u.ditherSize)
        // Godot's (dith || !should_dither): off swaps the whole band, not just the checker
        const ditherPass = dith.or(u.shouldDither.lessThan(0.5))
        const col = vec4(u.colors[0]).toVar()
        If(dLight.greaterThan(u.lightBorder1), () => {
            col.assign(u.colors[1])
            If(dLight.lessThan(u.lightBorder1.add(ditherBorder)).and(ditherPass), () => {
                col.assign(u.colors[0])
            })
        })
        If(dLight.greaterThan(u.lightBorder2), () => {
            col.assign(u.colors[2])
            If(dLight.lessThan(u.lightBorder2.add(ditherBorder)).and(ditherPass), () => {
                col.assign(u.colors[1])
            })
        })

        return vec4(col.xyz, alpha.mul(col.w))
    })

    const material = new MeshBasicNodeMaterial({ transparent: true })
    material.fragmentNode = fragment()
    return new Mesh(new PlaneGeometry(1, 1), material)
}
