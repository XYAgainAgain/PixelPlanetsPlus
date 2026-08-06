import { Mesh, MeshBasicNodeMaterial, PlaneGeometry, Vector4 } from 'three/webgpu'
import { Fn, If, distance, float, step, uniform, vec2, vec4 } from 'three/tsl'
import { circleCutout, makeFbm, pixelize, planetUv, rotateUv, spherify } from '../common'
import type { UF, UV2 } from '../common'
import type { LayerValues } from '../values'

/* LavaWorld/Rivers.gdshader: the glowing lava channels over the Lava World ground.
   Statement order follows the Godot fragment so reviews can diff line-by-line. */

export interface LavaRiversSharedUniforms {
    pixels: UF
    rotation: UF
    lightOrigin: UV2
    seed: UF
}

export const createLavaRiversUniforms = (v: LayerValues, shared: LavaRiversSharedUniforms) => ({
    ...shared,
    time: uniform(0.0),
    // Near-zero borders are correct once the d_light contrast step below is in place (W4)
    lightBorder1: uniform(v.lightBorder1 ?? 0.019),
    lightBorder2: uniform(v.lightBorder2 ?? 0.036),
    riverCutoff: uniform(v.riverCutoff ?? 0.579),
    colors: v.colors.map((c) => uniform(new Vector4(...c))),
})
export type LavaRiversUniforms = ReturnType<typeof createLavaRiversUniforms>

export const createLavaRiversLayer = (v: LayerValues, u: LavaRiversUniforms): Mesh => {
    const fbm = makeFbm(v.octaves ?? 4, v.noise ?? { hash: 15.5453, tiling: 'planet' })
    const size = float(v.size ?? 10.0)
    const timeSpeed = float(v.timeSpeed ?? 0.2)
    const rotationOffset = v.rotationOffset ?? 0.0

    const fragment = Fn(() => {
        // Pre-mutation reads frozen with .toVar(); see planetUnder.ts for the TSL gotcha
        const raw = planetUv().toVar()
        const uv = pixelize(raw, u.pixels).toVar()
        const dLight = distance(uv, u.lightOrigin).toVar()
        const alpha = circleCutout(uv).toVar()

        uv.assign(rotateUv(uv, u.rotation.add(rotationOffset)))
        uv.assign(spherify(uv))

        const fbm1 = fbm(uv.mul(size).add(vec2(u.time.mul(timeSpeed), 0.0)), u.seed, size).toVar()
        // Godot warps the raw uv here, not uv*size; the missing size multiply is intended
        const riverFbm = fbm(uv.add(fbm1.mul(2.5)), u.seed, size).toVar()

        // W4: the contrast step the JS port dropped, using the pre-step river fbm
        dLight.assign(dLight.pow(2.0).mul(0.4))
        dLight.subAssign(dLight.mul(riverFbm))

        riverFbm.assign(step(u.riverCutoff, riverFbm))

        const col = vec4(u.colors[0]).toVar()
        If(dLight.greaterThan(u.lightBorder1), () => { col.assign(u.colors[1]) })
        If(dLight.greaterThan(u.lightBorder2), () => { col.assign(u.colors[2]) })

        // Godot double-steps the already-stepped value; kept verbatim (a no-op for cutoff in (0,1])
        alpha.mulAssign(step(u.riverCutoff, riverFbm))
        return vec4(col.xyz, alpha.mul(col.w))
    })

    const material = new MeshBasicNodeMaterial({ transparent: true })
    material.fragmentNode = fragment()
    return new Mesh(new PlaneGeometry(1, 1), material)
}
