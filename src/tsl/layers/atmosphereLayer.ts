import { Mesh, MeshBasicNodeMaterial, PlaneGeometry, Vector4 } from 'three/webgpu'
import {
    Fn, If, distance, float, length, mix, smoothstep, step, uniform, vec4,
} from 'three/tsl'
import { ditherCheck, pixelize, planetUv } from '../common'
import type { UF, UV2 } from '../common'

/* The one JS-port invention we keep: an optional atmosphere rim with no Godot ancestor.
   Off by default in parity mode; the recipe decides whether to add it. */

// Rim alpha kept past each light border. Tunable by taste: the JS port's atmosphere was
// unlit and Deep-Fold has no atmosphere at all, so nothing upstream pins these.
const LIT_MID = 0.55
const LIT_DARK = 0.15

export interface AtmosphereSharedUniforms {
    pixels: UF
    lightOrigin: UV2
}

export const createAtmosphereUniforms = (shared: AtmosphereSharedUniforms) => ({
    ...shared,
    // Matches the water borders beneath so the rim's terminator lines up with the disc
    lightBorder1: uniform(0.4),
    lightBorder2: uniform(0.6),
    colors: [
        uniform(new Vector4(173 / 255, 216 / 255, 230 / 255, 0.25)),
        uniform(new Vector4(0 / 255, 127 / 255, 255 / 255, 0.35)),
        uniform(new Vector4(0 / 255, 0 / 255, 128 / 255, 0.45)),
    ],
})
export type AtmosphereUniforms = ReturnType<typeof createAtmosphereUniforms>

export const createAtmosphereLayer = (u: AtmosphereUniforms): Mesh => {
    const fragment = Fn(() => {
        const raw = planetUv().toVar()
        const uv = pixelize(raw, u.pixels).toVar()
        const dist = length(uv.mul(2.0).sub(1.0)).toVar()

        const col = vec4(mix(vec4(0.0), vec4(u.colors[0]), smoothstep(0.65, 0.87, dist))).toVar()
        col.assign(mix(col, vec4(u.colors[1]), smoothstep(0.87, 0.97, dist)))
        col.assign(mix(col, vec4(u.colors[2]), smoothstep(0.97, 1.04, dist)))
        // Upstream's smoothstep(1.04, 1.04, d) is degenerate (divide by zero); WGSL may NaN
        // where WebGL happened to clamp. step() is the behavior the old build actually showed.
        col.assign(mix(col, vec4(0.0), step(1.04, dist)))

        // Neither ancestor lights the rim, so it glowed just as hard on the night side. Same
        // band + dither grammar as every other layer, applied to alpha only so the hue survives.
        const dLight = distance(uv, u.lightOrigin).toVar()
        const dith = ditherCheck(uv, raw, u.pixels).toVar()
        const ditherBorder = float(1.0).div(u.pixels).mul(2.0)
        const lit = float(1.0).toVar()
        If(dLight.greaterThan(u.lightBorder1), () => {
            lit.assign(float(LIT_MID))
            If(dLight.lessThan(ditherBorder.add(u.lightBorder1)).and(dith), () => { lit.assign(float(1.0)) })
        })
        If(dLight.greaterThan(u.lightBorder2), () => {
            lit.assign(float(LIT_DARK))
            If(dLight.lessThan(ditherBorder.add(u.lightBorder2)).and(dith), () => { lit.assign(float(LIT_MID)) })
        })

        return vec4(col.xyz, col.w.mul(lit))
    })

    const material = new MeshBasicNodeMaterial({ transparent: true })
    material.fragmentNode = fragment()
    // The rim reaches ndc 1.04 but pixelize only reaches quadSize - 2/pixels, so upstream's
    // 1.02 cut it flat at the edges. Need >= 1.04 + 2/pixels; 1.2 clears the whole 16–4096 range.
    return new Mesh(new PlaneGeometry(1.2, 1.2), material)
}
