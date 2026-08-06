import { Mesh, MeshBasicNodeMaterial, PlaneGeometry, Vector4 } from 'three/webgpu'
import {
    Fn, If, distance, float, floor, int, min, pow, step, uniform, uniformArray, vec2, vec4,
} from 'three/tsl'
import { ditherCheck, makeFbm, pixelize, planetUv, rotateUv } from '../common'
import type { UF } from '../common'
import type { LayerValues } from '../values'

/* Galaxy/Galaxy.gdshader: the whole type is this one layer. No sphere, no light
   (set_light is a no-op in Godot), non-tiling noise. Statement order follows the fragment. */

// No lightOrigin: the shader has no light_origin uniform at all
export interface GalaxySharedUniforms {
    pixels: UF
    rotation: UF
    seed: UF
}

export const createGalaxyUniforms = (v: LayerValues, shared: GalaxySharedUniforms) => ({
    ...shared,
    time: uniform(0.0),
    // Float 0/1 stand-in for Godot's bool uniform; the toggle writes 1 or 0
    shouldDither: uniform(v.shouldDither === false ? 0.0 : 1.0),
    nColors: uniform(v.nColors ?? 6),
    tilt: uniform(v.tilt ?? 4.0),
    nLayers: uniform(v.nLayers ?? 4.0),
    layerHeight: uniform(v.layerHeight ?? 0.4),
    zoom: uniform(v.zoom ?? 2.0),
    swirl: uniform(v.swirl ?? -9.0),
    /* 7 slots with n_colors 6: slot 6 is deliberate headroom, reachable only through the
       min(f2, n_colors) clamp. uniformArray because the palette index is dynamic. */
    colors: uniformArray<'vec4'>(v.colors.map((c) => new Vector4(...c)), 'vec4'),
})
export type GalaxyUniforms = ReturnType<typeof createGalaxyUniforms>

export const createGalaxyLayer = (v: LayerValues, u: GalaxyUniforms): Mesh => {
    // OCTAVES 1: the spiral comes from the swirl warp, not fbm depth
    const fbm = makeFbm(v.octaves ?? 1, v.noise ?? { hash: 15.5453, tiling: 'none' })
    const size = float(v.size ?? 50.0)
    const timeSpeed = float(v.timeSpeed ?? 0.2)
    const rotationOffset = v.rotationOffset ?? 0.0

    const fragment = Fn(() => {
        // Pre-mutation reads frozen with .toVar(); see planetUnder.ts for the TSL gotcha
        const raw = planetUv().toVar()
        const uv = pixelize(raw, u.pixels).toVar()
        const dith = ditherCheck(uv, raw, u.pixels).toVar()

        uv.mulAssign(u.zoom)
        uv.subAssign(u.zoom.sub(1.0).div(2.0))
        uv.assign(rotateUv(uv, u.rotation.add(rotationOffset)))
        const uv2 = vec2(uv).toVar()

        // First tilt pass positions the layer field
        uv.assign(vec2(uv.x, uv.y.mul(u.tilt).sub(u.tilt.sub(1.0).div(2.0))))
        const dToCenter = distance(uv, vec2(0.5)).toVar()
        // Swirl grows with distance from center; negative swirl = counter-clockwise arms
        const rot = u.swirl.mul(pow(dToCenter, 0.4))
        const rotatedUv = rotateUv(uv, rot.add(u.time.mul(timeSpeed)))

        // f1 quantized to n_layers so layers don't blur through each other
        const f1 = fbm(rotatedUv.mul(size), u.seed, size).toVar()
        f1.assign(floor(f1.mul(u.nLayers)).div(u.nLayers))

        // Second tilt pass, on the untranslated copy, drooped per layer by f1
        uv2.assign(vec2(uv2.x, uv2.y.mul(u.tilt).sub(u.tilt.sub(1.0).div(2.0).add(f1.mul(u.layerHeight)))))
        const dToCenter2 = distance(uv2, vec2(0.5)).toVar()
        const rot2 = u.swirl.mul(pow(dToCenter2, 0.4))
        const rotatedUv2 = rotateUv(uv2, rot2.add(u.time.mul(timeSpeed)))
        // The + vec2(f1)*10.0 offset decorrelates the two fbm fields, hiding the layer seams
        const f2 = fbm(rotatedUv2.mul(size).add(vec2(f1).mul(10.0)), u.seed, size).toVar()

        // Alpha reads f2 pre-contrast; frozen before the mutations below
        const a = step(f2.add(dToCenter2), 0.7).toVar()

        f2.mulAssign(2.3)
        If(u.shouldDither.greaterThan(0.5).and(dith), () => { f2.mulAssign(0.94) })
        f2.assign(floor(f2.mul(u.nColors)))
        f2.assign(min(f2, u.nColors))
        const col = u.colors.element(int(f2))

        return vec4(col.xyz, a.mul(col.w))
    })

    const material = new MeshBasicNodeMaterial({ transparent: true })
    material.fragmentNode = fragment()
    return new Mesh(new PlaneGeometry(1, 1), material)
}
