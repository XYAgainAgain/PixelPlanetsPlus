import { Mesh, MeshBasicNodeMaterial, PlaneGeometry, Vector4 } from 'three/webgpu'
import { Fn, If, distance, float, step, uniform, vec2, vec4 } from 'three/tsl'
import { circleCutout, makeFbm, pixelize, planetUv, rotateUv, spherify } from '../common'
import type { UF, UV2 } from '../common'
import type { LayerValues } from '../values'

/* LandMasses/PlanetLandmass.gdshader: the continents over the Islands water.
   Statement order follows the Godot fragment (rotate before spherify, unlike PlanetUnder). */

export interface LandmassSharedUniforms {
    pixels: UF
    rotation: UF
    lightOrigin: UV2
    seed: UF
}

export const createLandmassUniforms = (v: LayerValues, shared: LandmassSharedUniforms) => ({
    ...shared,
    time: uniform(0.0),
    lightBorder1: uniform(v.lightBorder1 ?? 0.32),
    lightBorder2: uniform(v.lightBorder2 ?? 0.534),
    landCutoff: uniform(v.landCutoff ?? 0.633),
    colors: v.colors.map((c) => uniform(new Vector4(...c))),
})
export type LandmassUniforms = ReturnType<typeof createLandmassUniforms>

export const createLandmassLayer = (v: LayerValues, u: LandmassUniforms): Mesh => {
    const fbm = makeFbm(v.octaves ?? 6, v.noise ?? { hash: 15.5453, tiling: 'planet' })
    const size = float(v.size ?? 4.292)
    const timeSpeed = float(v.timeSpeed ?? 0.2)
    // The one rotation rule: layer rotation = shared tilt + rotationOffset (0.2 on Islands)
    const rotationOffset = v.rotationOffset ?? 0.0

    const fragment = Fn(() => {
        // Pre-mutation reads frozen with .toVar(); see planetUnder.ts for the TSL gotcha
        const raw = planetUv().toVar()
        const uv = pixelize(raw, u.pixels).toVar()
        const dLight = distance(uv, u.lightOrigin).toVar()
        const alpha = circleCutout(uv).toVar()

        uv.assign(rotateUv(uv, u.rotation.add(rotationOffset)))
        uv.assign(spherify(uv))

        const baseFbmUv = uv.mul(size).add(vec2(u.time.mul(timeSpeed), 0.0))
        const fbm1 = fbm(baseFbmUv, u.seed, size)
        const fbm2 = fbm(baseFbmUv.sub(u.lightOrigin.mul(fbm1)), u.seed, size).toVar()
        const fbm3 = fbm(baseFbmUv.sub(u.lightOrigin.mul(1.5).mul(fbm1)), u.seed, size).toVar()
        const fbm4 = fbm(baseFbmUv.sub(u.lightOrigin.mul(2.0).mul(fbm1)), u.seed, size).toVar()

        If(dLight.lessThan(u.lightBorder1), () => { fbm4.mulAssign(0.9) })
        If(dLight.greaterThan(u.lightBorder1), () => {
            fbm2.mulAssign(1.05); fbm3.mulAssign(1.05); fbm4.mulAssign(1.05)
        })
        If(dLight.greaterThan(u.lightBorder2), () => {
            fbm2.mulAssign(1.3); fbm3.mulAssign(1.4); fbm4.mulAssign(1.8)
        })

        const dContrast = dLight.pow(2.0).mul(0.1)
        const col = vec4(u.colors[3]).toVar()
        If(fbm4.add(dContrast).lessThan(fbm1), () => { col.assign(u.colors[2]) })
        If(fbm3.add(dContrast).lessThan(fbm1), () => { col.assign(u.colors[1]) })
        If(fbm2.add(dContrast).lessThan(fbm1), () => { col.assign(u.colors[0]) })

        return vec4(col.xyz, step(u.landCutoff, fbm1).mul(alpha).mul(col.w))
    })

    const material = new MeshBasicNodeMaterial({ transparent: true })
    material.fragmentNode = fragment()
    return new Mesh(new PlaneGeometry(1, 1), material)
}
