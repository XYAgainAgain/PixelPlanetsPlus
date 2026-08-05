import { Mesh, MeshBasicNodeMaterial, PlaneGeometry, Vector4 } from 'three/webgpu'
import { Fn, If, distance, float, length, mix, positionGeometry, smoothstep, step, uniform, vec4 } from 'three/tsl'
import { ditherCheck, pixelize } from '../common'
import type { IslandsUniforms } from '../planets/islands'

/* TSL port of the upstream atmosphere GLSL. Upstream hardcoded pixels=100 here;
   deliberate upgrade: it follows the shared pixels uniform so the slider moves everything. */

// Rim alpha kept past each light border. Tunable by taste: the JS port's atmosphere was
// unlit and Deep-Fold has no atmosphere at all, so nothing upstream pins these.
const LIT_MID = 0.55
const LIT_DARK = 0.15

export const createIslandsAtmosphereLayer = (u: IslandsUniforms): Mesh => {
    // Fresh Vector4s per call: uniform() stores by reference, and planets must not share
    const c1 = uniform(new Vector4(173 / 255, 216 / 255, 230 / 255, 0.25))
    const c2 = uniform(new Vector4(0 / 255, 127 / 255, 255 / 255, 0.35))
    const c3 = uniform(new Vector4(0 / 255, 0 / 255, 128 / 255, 0.45))

    const fragment = Fn(() => {
        const raw = positionGeometry.xy
        const uv = pixelize(raw, u.pixels).toVar()
        const dist = length(uv.mul(2.0).sub(1.0)).toVar()

        const col = vec4(mix(vec4(0.0), vec4(c1), smoothstep(0.65, 0.87, dist))).toVar()
        col.assign(mix(col, vec4(c2), smoothstep(0.87, 0.97, dist)))
        col.assign(mix(col, vec4(c3), smoothstep(0.97, 1.04, dist)))
        // Upstream's smoothstep(1.04, 1.04, d) is degenerate (divide by zero); WGSL may NaN
        // where WebGL happened to clamp. step() is the behavior the old build actually showed.
        col.assign(mix(col, vec4(0.0), step(1.04, dist)))

        // Neither ancestor lights the rim, so it glowed just as hard on the night side. Same
        // band + dither grammar as every other layer, applied to alpha only so the hue survives.
        const dLight = distance(uv, u.lightOrigin).toVar()
        const dith = ditherCheck(uv, raw, u.pixels).toVar()
        const ditherBorder = float(1.0).div(u.pixels).mul(2.0)
        const border1 = u.lightBordersAtmo.x
        const border2 = u.lightBordersAtmo.y
        const lit = float(1.0).toVar()
        If(dLight.greaterThan(border1), () => {
            lit.assign(float(LIT_MID))
            If(dLight.lessThan(ditherBorder.add(border1)).and(dith), () => { lit.assign(float(1.0)) })
        })
        If(dLight.greaterThan(border2), () => {
            lit.assign(float(LIT_DARK))
            If(dLight.lessThan(ditherBorder.add(border2)).and(dith), () => { lit.assign(float(LIT_MID)) })
        })

        return vec4(col.xyz, col.w.mul(lit))
    })

    const material = new MeshBasicNodeMaterial({ transparent: true })
    material.fragmentNode = fragment()
    // The rim reaches ndc 1.04 but pixelize only reaches quadSize - 2/pixels, so upstream's
    // 1.02 cut it flat at the edges. Need >= 1.04 + 2/pixels; 1.2 clears the whole 16–4096 range.
    return new Mesh(new PlaneGeometry(1.2, 1.2), material)
}
