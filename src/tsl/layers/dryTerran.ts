import { Mesh, MeshBasicNodeMaterial, PlaneGeometry, Vector4 } from 'three/webgpu'
import {
    Fn, If, distance, float, int, mix, pow, smoothstep, uniform, uniformArray, vec2, vec4,
} from 'three/tsl'
import {
    circleCutout, ditherCheck, makeFbm, pixelize, planetUv, posterizeClamp, rotateUv, spherify,
} from '../common'
import type { UF, UV2 } from '../common'
import type { LayerValues } from '../values'

/* DryTerran.tscn inline shader: the only planet lit by a posterized continuous ramp indexed
   into the palette instead of the usual two-border band swap. Statement order follows Godot. */

export interface DryTerranSharedUniforms {
    pixels: UF
    rotation: UF
    lightOrigin: UV2
    seed: UF
}

export const createDryTerranUniforms = (v: LayerValues, shared: DryTerranSharedUniforms) => ({
    ...shared,
    time: uniform(0.0),
    lightDistance1: uniform(v.lightDistance1 ?? 0.362),
    lightDistance2: uniform(v.lightDistance2 ?? 0.525),
    // Float 0/1 stand-in for Godot's bool uniform; the toggle writes 1 or 0
    shouldDither: uniform(v.shouldDither === false ? 0.0 : 1.0),
    // uniformArray, not uniform()[]: the palette index is dynamic (edit via colors.array[i])
    colors: uniformArray<'vec4'>(v.colors.map((c) => new Vector4(...c)), 'vec4'),
})
export type DryTerranUniforms = ReturnType<typeof createDryTerranUniforms>

export const createDryTerranLayer = (v: LayerValues, u: DryTerranUniforms): Mesh => {
    const fbm = makeFbm(v.octaves ?? 3, v.noise ?? { hash: 43758.5453, tiling: 'planet' })
    const size = float(v.size ?? 8.0)
    const timeSpeed = float(v.timeSpeed ?? 0.1)
    const nColorsMinus1 = float((v.nColors ?? v.colors.length) - 1)

    const fragment = Fn(() => {
        // Pre-mutation reads frozen with .toVar(); see planetUnder.ts for the TSL gotcha
        const raw = planetUv().toVar()
        const uv = pixelize(raw, u.pixels).toVar()
        const dith = ditherCheck(uv, raw, u.pixels).toVar()
        const alpha = circleCutout(uv).toVar()

        uv.assign(spherify(uv))
        // Unlike PlanetUnder, light distance reads the spherified (pre-rotation) uv
        const dLight = distance(uv, u.lightOrigin).toVar()
        uv.assign(rotateUv(uv, u.rotation))

        const f = fbm(uv.mul(size).add(vec2(u.time.mul(timeSpeed), 0.0)), u.seed, size).toVar()

        dLight.assign(smoothstep(-0.3, 1.2, dLight))
        // Feather the two radial darkening steps so posterization cannot expose their circular seams.
        const lightFeather = float(0.03)
        dLight.mulAssign(mix(0.9, 1.0, smoothstep(
            u.lightDistance1.sub(lightFeather), u.lightDistance1.add(lightFeather), dLight,
        )))
        dLight.mulAssign(mix(0.9, 1.0, smoothstep(
            u.lightDistance2.sub(lightFeather), u.lightDistance2.add(lightFeather), dLight,
        )))

        const c = dLight.mul(pow(f, 0.8)).mul(3.5).toVar()
        // Godot's (dith || !should_dither): off brightens every texel, not just the checker
        If(dith.or(u.shouldDither.lessThan(0.5)), () => {
            c.addAssign(0.02)
            c.mulAssign(1.05)
        })

        const post = posterizeClamp(c, float(4.0), float(1.0))
        const col = vec4(u.colors.element(int(post.mul(nColorsMinus1))))
        return vec4(col.xyz, alpha.mul(col.w))
    })

    const material = new MeshBasicNodeMaterial({ transparent: true })
    material.fragmentNode = fragment()
    return new Mesh(new PlaneGeometry(1, 1), material)
}
