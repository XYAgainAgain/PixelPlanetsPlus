import { Mesh, MeshBasicNodeMaterial, PlaneGeometry, Vector2, Vector4 } from 'three/webgpu'
import { Fn, If, distance, float, pow, select, smoothstep, step, uniform, vec2, vec4 } from 'three/tsl'
import { ditherCheck, makeFbm, pixelize, planetUv, posterizeIndex, rotateUv } from '../common'
import type { NF, UF, UV2 } from '../common'
import type { LayerValues } from '../values'

/* BlackHole/BlackHoleRing.gdshader: the oversized, extremely edge-on accretion disk. */

export interface AccretionDiskSharedUniforms {
    planetPixels: UF
    rotation: UF
    seed: UF
}

export const createAccretionDiskUniforms = (v: LayerValues, shared: AccretionDiskSharedUniforms) => ({
    ...shared,
    time: uniform(0.0),
    lightOrigin: uniform(new Vector2(...(v.lightOrigin ?? [0.39, 0.39]))) as UV2,
    timeSpeed: uniform(v.timeSpeed ?? 0.2),
    diskWidth: uniform(v.diskWidth ?? 0.1),
    ringPerspective: uniform(v.ringPerspective ?? 4.0),
    shouldDither: uniform(v.shouldDither === false ? 0.0 : 1.0),
    nColors: uniform(v.nColors ?? 5),
    colors: v.colors.map((c) => uniform(new Vector4(...c))),
})
export type AccretionDiskUniforms = ReturnType<typeof createAccretionDiskUniforms>

// Several Godot calls use a dynamic first edge that can equal the fixed second edge.
const safeSmoothstep = Fn(([edge0, edge1, x]: [NF, NF, NF]) => {
    const safeEdge1 = float(edge1).toVar()
    If(edge1.sub(edge0).abs().lessThan(0.000001), () => {
        safeEdge1.addAssign(select(edge1.greaterThanEqual(edge0), 0.000001, -0.000001))
    })
    return smoothstep(edge0, safeEdge1, x)
})

export const createAccretionDiskLayer = (v: LayerValues, u: AccretionDiskUniforms): Mesh => {
    const fbm = makeFbm(v.octaves ?? 3, v.noise ?? { hash: 15.5453, tiling: 'planet' })
    const size = float(v.size ?? 50.0)
    const rotationOffset = v.rotationOffset ?? 0.0
    const pixelScale = v.quadScale

    const fragment = Fn(() => {
        const raw = planetUv().toVar()
        const pixels = u.planetPixels.mul(pixelScale)
        const uv = pixelize(raw, pixels).toVar()
        const dith = ditherCheck(uv, raw, pixels).toVar()

        uv.assign(rotateUv(uv, u.rotation.add(rotationOffset)))
        const uv2 = vec2(uv).toVar()

        uv.assign(vec2(uv.x.sub(0.5).mul(1.3).add(0.5), uv.y))
        uv.assign(rotateUv(uv, u.time.mul(u.timeSpeed).mul(2.0).sin().mul(0.01)))

        const lOrigin = vec2(0.5).toVar()
        const dWidth = float(u.diskWidth).toVar()

        If(uv.y.lessThan(0.5), () => {
            uv.assign(vec2(uv.x, uv.y.add(safeSmoothstep(distance(vec2(0.5), uv), 0.5, 0.2))))
            dWidth.addAssign(safeSmoothstep(distance(vec2(0.5), uv), 0.5, 0.3))
            lOrigin.assign(vec2(lOrigin.x, lOrigin.y.sub(safeSmoothstep(distance(vec2(0.5), uv), 0.5, 0.2))))
        }).ElseIf(uv.y.greaterThan(0.53), () => {
            uv.assign(vec2(uv.x, uv.y.sub(safeSmoothstep(distance(vec2(0.5), uv), 0.4, 0.17))))
            dWidth.addAssign(safeSmoothstep(distance(vec2(0.5), uv), 0.5, 0.2))
            lOrigin.assign(vec2(lOrigin.x, lOrigin.y.add(safeSmoothstep(distance(vec2(0.5), uv), 0.5, 0.2))))
        })

        const perspective = vec2(1.0, u.ringPerspective)
        const lightD = distance(uv2.mul(perspective), lOrigin.mul(perspective)).mul(0.3)
        const uvCenter = uv.sub(vec2(0.0, 0.5)).mul(perspective).toVar()
        const centerD = distance(uvCenter, vec2(0.5, 0.0))

        const disk = safeSmoothstep(float(0.1).sub(dWidth.mul(2.0)), float(0.5).sub(dWidth), centerD).toVar()
        disk.mulAssign(safeSmoothstep(centerD.sub(dWidth), centerD, 0.4))

        uvCenter.assign(rotateUv(uvCenter.add(vec2(0.0, 0.5)), u.time.mul(u.timeSpeed).mul(3.0)))
        disk.mulAssign(pow(fbm(uvCenter.mul(size), u.seed, size), 0.5))

        If(dith.or(u.shouldDither.lessThan(0.5)), () => { disk.mulAssign(1.2) })

        const nPosterized = u.nColors.sub(1.0)
        const paletteIndex = posterizeIndex(disk.add(lightD), nPosterized)
        const col = vec4(u.colors[0]).toVar()
        If(paletteIndex.greaterThanEqual(1.0), () => { col.assign(u.colors[1]) })
        If(paletteIndex.greaterThanEqual(2.0), () => { col.assign(u.colors[2]) })
        If(paletteIndex.greaterThanEqual(3.0), () => { col.assign(u.colors[3]) })
        If(paletteIndex.greaterThanEqual(4.0), () => { col.assign(u.colors[4]) })

        const diskAlpha = step(0.15, disk)
        return vec4(col.xyz, diskAlpha.mul(col.w))
    })

    const material = new MeshBasicNodeMaterial({ transparent: true })
    material.fragmentNode = fragment()
    const mesh = new Mesh(new PlaneGeometry(1, 1), material)
    mesh.scale.setScalar(v.quadScale)
    return mesh
}
