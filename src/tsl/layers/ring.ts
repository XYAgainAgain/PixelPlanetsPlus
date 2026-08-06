import { Mesh, MeshBasicNodeMaterial, PlaneGeometry, Vector4 } from 'three/webgpu'
import { Fn, If, distance, float, pow, smoothstep, step, uniform, vec2, vec4 } from 'three/tsl'
import { makeFbm, pixelize, planetUv, posterizeClamp, rotateUv } from '../common'
import type { UF, UV2 } from '../common'
import type { LayerValues } from '../values'

export interface RingSharedUniforms {
    planetPixels: UF
    rotation: UF
    lightOrigin: UV2
    seed: UF
}

export const createRingUniforms = (v: LayerValues, shared: RingSharedUniforms) => ({
    ...shared,
    time: uniform(0.0),
    ringWidth: uniform(v.ringWidth ?? 0.127),
    ringPerspective: uniform(v.ringPerspective ?? 6.0),
    scaleRelToPlanet: uniform(v.scaleRelToPlanet ?? 6.0),
    occludesPlanet: uniform(1.0),
    colors: v.colors.map((c) => uniform(new Vector4(...c))),
    darkColors: (v.darkColors ?? v.colors).map((c) => uniform(new Vector4(...c))),
})
export type RingUniforms = ReturnType<typeof createRingUniforms>

export const createRingLayer = (v: LayerValues, u: RingUniforms): Mesh => {
    const fbm = makeFbm(v.octaves ?? 4, v.noise ?? { hash: 15.5453, tiling: 'planet' })
    const size = float(v.size ?? 15.0)
    const timeSpeed = float(v.timeSpeed ?? 0.2)
    const rotationOffset = v.rotationOffset ?? 0.0
    const pixelScale = v.quadScale

    const fragment = Fn(() => {
        const raw = planetUv().toVar()
        const uv = pixelize(raw, u.planetPixels.mul(pixelScale)).toVar()
        const lightD = distance(uv, u.lightOrigin).toVar()
        uv.assign(rotateUv(uv, u.rotation.add(rotationOffset)))

        const uvCenter = uv.sub(vec2(0.0, 0.5)).mul(vec2(1.0, u.ringPerspective)).toVar()
        const centerD = distance(uvCenter, vec2(0.5, 0.0))
        const ring = smoothstep(float(0.5).sub(u.ringWidth.mul(2.0)), float(0.5).sub(u.ringWidth), centerD)
            .mul(smoothstep(centerD.sub(u.ringWidth), centerD, 0.4)).toVar()

        // Deliberate upgrade: a hidden gas layer no longer erases the ring's front-facing center.
        If(uv.y.lessThan(0.5).and(u.occludesPlanet.greaterThan(0.5)), () => {
            ring.mulAssign(step(float(1.0).div(u.scaleRelToPlanet), distance(uv, vec2(0.5))))
        })

        uvCenter.assign(rotateUv(uvCenter.add(vec2(0.0, 0.5)), u.time.mul(timeSpeed)))
        ring.mulAssign(fbm(uvCenter.mul(size), u.seed, size))

        const posterized = posterizeClamp(ring.add(pow(lightD, 2.0).mul(2.0)), float(4.0), float(2.0))
        const col = vec4(u.colors[0]).toVar()
        If(posterized.lessThanEqual(1.0), () => {
            If(posterized.greaterThanEqual(0.5), () => { col.assign(u.colors[1]) })
            If(posterized.greaterThanEqual(1.0), () => { col.assign(u.colors[2]) })
        }).Else(() => {
            const darkIndex = posterized.sub(1.0).mul(2.0)
            col.assign(u.darkColors[0])
            If(darkIndex.greaterThanEqual(1.0), () => { col.assign(u.darkColors[1]) })
            If(darkIndex.greaterThanEqual(2.0), () => { col.assign(u.darkColors[2]) })
        })

        return vec4(col.xyz, step(0.28, ring).mul(col.w))
    })

    const material = new MeshBasicNodeMaterial({ transparent: true })
    material.fragmentNode = fragment()
    const mesh = new Mesh(new PlaneGeometry(1, 1), material)
    mesh.scale.setScalar(v.quadScale)
    return mesh
}
