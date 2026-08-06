import { Mesh, MeshBasicNodeMaterial, PlaneGeometry, Vector4 } from 'three/webgpu'
import { Fn, If, distance, float, step, uniform, vec2, vec4 } from 'three/tsl'
import {
    circleCutout, ditherCheck, makeFbm, pixelize, planetUv, rotateUv, spherify,
} from '../common'
import type { UF, UV2 } from '../common'
import type { LayerValues } from '../values'

/* Rivers/LandRivers.gdshader: Terran Wet's fused land-and-rivers layer, 4 land colors plus
   2 river colors. Statement order follows the Godot fragment (spherify, d_light, then rotate). */

export interface LandRiversSharedUniforms {
    pixels: UF
    rotation: UF
    lightOrigin: UV2
    seed: UF
}

export const createLandRiversUniforms = (v: LayerValues, shared: LandRiversSharedUniforms) => ({
    ...shared,
    time: uniform(0.0),
    lightBorder1: uniform(v.lightBorder1 ?? 0.287),
    lightBorder2: uniform(v.lightBorder2 ?? 0.476),
    riverCutoff: uniform(v.riverCutoff ?? 0.368),
    // 3.951 on Terran Wet: the only non-2.0 dither width in the whole project
    ditherSize: uniform(v.ditherSize ?? 3.951),
    // Float 0/1 stand-in for Godot's bool uniform; the toggle writes 1 or 0
    shouldDither: uniform(v.shouldDither === false ? 0.0 : 1.0),
    colors: v.colors.map((c) => uniform(new Vector4(...c))),
})
export type LandRiversUniforms = ReturnType<typeof createLandRiversUniforms>

export const createLandRiversLayer = (v: LayerValues, u: LandRiversUniforms): Mesh => {
    const fbm = makeFbm(v.octaves ?? 6, v.noise ?? { hash: 15.5453, tiling: 'planet' })
    const size = float(v.size ?? 4.6)
    const timeSpeed = float(v.timeSpeed ?? 0.1)
    // The one rotation rule: layer rotation = shared tilt + rotationOffset (0.2 here)
    const rotationOffset = v.rotationOffset ?? 0.0

    const fragment = Fn(() => {
        // Pre-mutation reads frozen with .toVar(); see planetUnder.ts for the TSL gotcha
        const raw = planetUv().toVar()
        const uv = pixelize(raw, u.pixels).toVar()
        const dith = ditherCheck(uv, raw, u.pixels).toVar()
        const alpha = circleCutout(uv).toVar()

        uv.assign(spherify(uv))
        // Unlike PlanetLandmass, d_light samples the spherified uv, before the tilt
        const dLight = distance(uv, u.lightOrigin).toVar()
        uv.assign(rotateUv(uv, u.rotation.add(rotationOffset)))

        const baseFbmUv = uv.mul(size).add(vec2(u.time.mul(timeSpeed), 0.0))
        const fbm1 = fbm(baseFbmUv, u.seed, size)
        const fbm2 = fbm(baseFbmUv.sub(u.lightOrigin.mul(fbm1)), u.seed, size).toVar()
        const fbm3 = fbm(baseFbmUv.sub(u.lightOrigin.mul(1.5).mul(fbm1)), u.seed, size).toVar()
        const fbm4 = fbm(baseFbmUv.sub(u.lightOrigin.mul(2.0).mul(fbm1)), u.seed, size).toVar()
        const riverFbm = step(u.riverCutoff, fbm(baseFbmUv.add(fbm1.mul(6.0)), u.seed, size))

        const ditherBorder = float(1.0).div(u.pixels).mul(u.ditherSize)
        // Godot's (dith || !should_dither): off dims the whole band, not just the checker
        const ditherPass = dith.or(u.shouldDither.lessThan(0.5))
        If(dLight.lessThan(u.lightBorder1), () => { fbm4.mulAssign(0.9) })
        If(dLight.greaterThan(u.lightBorder1), () => {
            fbm2.mulAssign(1.05); fbm3.mulAssign(1.05); fbm4.mulAssign(1.05)
        })
        If(dLight.greaterThan(u.lightBorder2), () => {
            fbm2.mulAssign(1.3); fbm3.mulAssign(1.4); fbm4.mulAssign(1.8)
            If(dLight.lessThan(u.lightBorder2.add(ditherBorder)).and(ditherPass), () => {
                fbm4.mulAssign(0.5)
            })
        })

        dLight.assign(dLight.pow(2.0).mul(0.4))
        const col = vec4(u.colors[3]).toVar()
        If(fbm4.add(dLight).lessThan(fbm1.mul(1.5)), () => { col.assign(u.colors[2]) })
        If(fbm3.add(dLight).lessThan(fbm1), () => { col.assign(u.colors[1]) })
        If(fbm2.add(dLight).lessThan(fbm1), () => { col.assign(u.colors[0]) })
        If(riverFbm.lessThan(fbm1.mul(0.5)), () => {
            col.assign(u.colors[5])
            If(fbm4.add(dLight).lessThan(fbm1.mul(1.5)), () => { col.assign(u.colors[4]) })
        })

        return vec4(col.xyz, alpha.mul(col.w))
    })

    const material = new MeshBasicNodeMaterial({ transparent: true })
    material.fragmentNode = fragment()
    return new Mesh(new PlaneGeometry(1, 1), material)
}
