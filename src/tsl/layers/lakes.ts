import { Mesh, MeshBasicNodeMaterial, PlaneGeometry, Vector4 } from 'three/webgpu'
import { Fn, If, distance, float, step, uniform, vec2, vec4 } from 'three/tsl'
import { circleCutout, makeFbm, pixelize, planetUv, rotateUv, spherify } from '../common'
import type { UF, UV2 } from '../common'
import type { LayerValues } from '../values'

/* The Ice World lake shader, embedded in IceWorld.tscn (no .gdshader file exists).
   Statement order follows the Godot fragment so reviews can diff line-by-line. */

export interface LakesSharedUniforms {
    pixels: UF
    rotation: UF
    lightOrigin: UV2
    seed: UF
}

export const createLakesUniforms = (v: LayerValues, shared: LakesSharedUniforms) => ({
    ...shared,
    time: uniform(0.0),
    // Near-zero borders are correct once the d_light contrast step below is in place (W4)
    lightBorder1: uniform(v.lightBorder1 ?? 0.024),
    lightBorder2: uniform(v.lightBorder2 ?? 0.047),
    lakeCutoff: uniform(v.lakeCutoff ?? 0.55),
    colors: v.colors.map((c) => uniform(new Vector4(...c))),
})
export type LakesUniforms = ReturnType<typeof createLakesUniforms>

export const createLakesLayer = (v: LayerValues, u: LakesUniforms): Mesh => {
    // This shader and Terran Dry alone hash with 43758.5453 (S13)
    const fbm = makeFbm(v.octaves ?? 3, v.noise ?? { hash: 43758.5453, tiling: 'planet' })
    const size = float(v.size ?? 10.0)
    const timeSpeed = float(v.timeSpeed ?? 0.2)
    const rotationOffset = v.rotationOffset ?? 0.0

    const fragment = Fn(() => {
        // Pre-mutation reads frozen with .toVar(); see planetUnder.ts for the TSL gotcha
        const raw = planetUv().toVar()
        const uv = pixelize(raw, u.pixels).toVar()
        const dLight = distance(uv, u.lightOrigin).toVar()

        uv.assign(rotateUv(uv, u.rotation.add(rotationOffset)))
        // W5: the circle mask comes from the rotated, pre-spherify uv, unlike every sibling
        const cutout = circleCutout(uv).toVar()
        uv.assign(spherify(uv))

        const lake = fbm(uv.mul(size).add(vec2(u.time.mul(timeSpeed), 0.0)), u.seed, size).toVar()

        // W4: the contrast step the JS port dropped; it is what makes tiny borders correct
        dLight.assign(dLight.pow(2.0).mul(0.4))
        dLight.subAssign(dLight.mul(lake))

        const col = vec4(u.colors[0]).toVar()
        If(dLight.greaterThan(u.lightBorder1), () => { col.assign(u.colors[1]) })
        If(dLight.greaterThan(u.lightBorder2), () => { col.assign(u.colors[2]) })

        const alpha = step(u.lakeCutoff, lake).mul(cutout)
        return vec4(col.xyz, alpha.mul(col.w))
    })

    const material = new MeshBasicNodeMaterial({ transparent: true })
    material.fragmentNode = fragment()
    return new Mesh(new PlaneGeometry(1, 1), material)
}
