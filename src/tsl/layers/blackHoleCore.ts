import { Mesh, MeshBasicNodeMaterial, PlaneGeometry, Vector4 } from 'three/webgpu'
import { Fn, If, distance, step, uniform, vec2, vec4 } from 'three/tsl'
import { pixelize, planetUv } from '../common'
import type { UF } from '../common'
import type { LayerValues } from '../values'

/* BlackHole/BlackHole.gdshader: a purely radial core with two photon-ring bands. */

export interface BlackHoleCoreSharedUniforms {
    pixels: UF
}

export const createBlackHoleCoreUniforms = (v: LayerValues, shared: BlackHoleCoreSharedUniforms) => ({
    ...shared,
    radius: uniform(v.radius ?? 0.5),
    lightWidth: uniform(v.lightWidth ?? 0.05),
    colors: v.colors.map((c) => uniform(new Vector4(...c))),
})
export type BlackHoleCoreUniforms = ReturnType<typeof createBlackHoleCoreUniforms>

export const createBlackHoleCoreLayer = (_v: LayerValues, u: BlackHoleCoreUniforms): Mesh => {
    const fragment = Fn(() => {
        const uv = pixelize(planetUv(), u.pixels).toVar()
        const dToCenter = distance(uv, vec2(0.5)).toVar()

        const col = vec4(u.colors[0]).toVar()
        If(dToCenter.greaterThan(u.radius.sub(u.lightWidth)), () => { col.assign(u.colors[1]) })
        If(dToCenter.greaterThan(u.radius.sub(u.lightWidth.mul(0.5))), () => { col.assign(u.colors[2]) })

        const alpha = step(dToCenter, u.radius)
        return vec4(col.xyz, alpha.mul(col.w))
    })

    const material = new MeshBasicNodeMaterial({ transparent: true })
    material.fragmentNode = fragment()
    return new Mesh(new PlaneGeometry(1, 1), material)
}
