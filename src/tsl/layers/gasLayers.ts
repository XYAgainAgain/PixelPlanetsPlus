import { Mesh, MeshBasicNodeMaterial, PlaneGeometry, Vector4 } from 'three/webgpu'
import { Fn, If, Loop, distance, float, floor, pow, smoothstep, uniform, vec2, vec4 } from 'three/tsl'
import { circleCutout, ditherCheck, makeCircleNoise, makeFbm, pixelize, planetUv, rotateUv, spherify } from '../common'
import type { UF, UV2 } from '../common'
import type { LayerValues } from '../values'

export interface GasLayersSharedUniforms {
    pixels: UF
    rotation: UF
    lightOrigin: UV2
    seed: UF
}

export const createGasLayersUniforms = (v: LayerValues, shared: GasLayersSharedUniforms) => ({
    ...shared,
    time: uniform(0.0),
    cloudCover: uniform(v.cloudCover ?? 0.61),
    stretch: uniform(v.stretch ?? 2.204),
    cloudCurve: uniform(v.cloudCurve ?? 1.376),
    lightBorder1: uniform(v.lightBorder1 ?? 0.52),
    lightBorder2: uniform(v.lightBorder2 ?? 0.62),
    bands: uniform(v.bands ?? 0.892),
    shouldDither: uniform(v.shouldDither === false ? 0.0 : 1.0),
    colors: v.colors.map((c) => uniform(new Vector4(...c))),
    darkColors: (v.darkColors ?? v.colors).map((c) => uniform(new Vector4(...c))),
})
export type GasLayersUniforms = ReturnType<typeof createGasLayersUniforms>

export const createGasLayersLayer = (v: LayerValues, u: GasLayersUniforms): Mesh => {
    const spec = v.noise ?? { hash: 15.5453, tiling: 'planet' as const }
    const fbm = makeFbm(v.octaves ?? 3, spec)
    const circleNoise = makeCircleNoise(spec)
    const size = float(v.size ?? 10.107)
    const timeSpeed = float(v.timeSpeed ?? 0.05)
    const rotationOffset = v.rotationOffset ?? 0.0

    const fragment = Fn(() => {
        const raw = planetUv().toVar()
        const uv = pixelize(raw, u.pixels).toVar()
        const lightD = distance(uv, u.lightOrigin).toVar()
        const dith = ditherCheck(uv, raw, u.pixels).toVar()
        const alpha = circleCutout(uv).toVar()

        uv.assign(rotateUv(uv, u.rotation.add(rotationOffset)))
        uv.assign(spherify(uv))

        const band = fbm(vec2(0.0, uv.y.mul(size).mul(u.bands)), u.seed, size)
        const turb = float(0.0).toVar()
        Loop(10, ({ i }) => {
            turb.addAssign(circleNoise(uv.mul(size).mul(0.3).add(float(i).add(11.0))
                .add(vec2(u.time.mul(timeSpeed), 0.0)), u.seed, size))
        })

        const fbm1 = fbm(uv.mul(size), u.seed, size)
        const fbm2 = fbm(uv.mul(vec2(1.0, 2.0)).mul(size).add(fbm1)
            .add(vec2(u.time.mul(timeSpeed).negate(), 0.0)).add(turb), u.seed, size).toVar()
        fbm2.mulAssign(pow(band, 2.0).mul(7.0))
        const light = fbm2.add(lightD.mul(1.8)).toVar()
        fbm2.addAssign(pow(lightD, 1.0).sub(0.3))
        fbm2.assign(smoothstep(-0.2, float(4.0).sub(fbm2), light))
        If(dith.and(u.shouldDither.greaterThanEqual(0.5)), () => { fbm2.mulAssign(1.1) })

        const posterized = floor(fbm2.mul(4.0)).div(2.0)
        const col = vec4(0.0, 0.0, 0.0, 1.0).toVar()
        If(fbm2.lessThan(0.625), () => {
            col.assign(u.colors[0])
            If(posterized.greaterThanEqual(0.5), () => { col.assign(u.colors[1]) })
            If(posterized.greaterThanEqual(1.0), () => { col.assign(u.colors[2]) })
        }).Else(() => {
            const darkIndex = posterized.sub(1.0).mul(2.0)
            col.assign(u.darkColors[0])
            If(darkIndex.greaterThanEqual(1.0), () => { col.assign(u.darkColors[1]) })
            If(darkIndex.greaterThanEqual(2.0), () => { col.assign(u.darkColors[2]) })
        })

        return vec4(col.xyz, alpha.mul(col.w))
    })

    const material = new MeshBasicNodeMaterial({ transparent: true })
    material.fragmentNode = fragment()
    return new Mesh(new PlaneGeometry(1, 1), material)
}
