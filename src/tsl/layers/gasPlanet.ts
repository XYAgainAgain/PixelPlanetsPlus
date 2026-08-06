import { Mesh, MeshBasicNodeMaterial, PlaneGeometry, Vector4 } from 'three/webgpu'
import { Fn, If, Loop, distance, float, smoothstep, step, uniform, vec2, vec4 } from 'three/tsl'
import { circleCutout, makeCircleNoise, makeFbm, pixelize, planetUv, rotateUv, spherify } from '../common'
import type { UF, UV2 } from '../common'
import type { LayerValues } from '../values'

export interface GasPlanetSharedUniforms {
    pixels: UF
    rotation: UF
    lightOrigin: UV2
    seed: UF
}

export const createGasPlanetUniforms = (v: LayerValues, shared: GasPlanetSharedUniforms) => ({
    ...shared,
    time: uniform(0.0),
    cloudCover: uniform(v.cloudCover ?? 0.0),
    stretch: uniform(v.stretch ?? 1.0),
    cloudCurve: uniform(v.cloudCurve ?? 1.3),
    lightBorder1: uniform(v.lightBorder1 ?? 0.52),
    lightBorder2: uniform(v.lightBorder2 ?? 0.62),
    colors: v.colors.map((c) => uniform(new Vector4(...c))),
})
export type GasPlanetUniforms = ReturnType<typeof createGasPlanetUniforms>

export const createGasPlanetLayer = (v: LayerValues, u: GasPlanetUniforms): Mesh => {
    const spec = v.noise ?? { hash: 15.5453, tiling: 'simple' as const }
    const fbm = makeFbm(v.octaves ?? 5, spec)
    const circleNoise = makeCircleNoise(spec)
    const size = float(v.size ?? 9.0)
    const timeSpeed = float(v.timeSpeed ?? 0.2)
    const rotationOffset = v.rotationOffset ?? 0.0

    const fragment = Fn(() => {
        const raw = planetUv().toVar()
        const uv = pixelize(raw, u.pixels).toVar()
        const dLight = distance(uv, u.lightOrigin).toVar()
        const alpha = circleCutout(uv).toVar()

        uv.assign(rotateUv(uv, u.rotation.add(rotationOffset)))
        uv.assign(spherify(uv))
        uv.assign(vec2(uv.x, uv.y.add(smoothstep(0.0, u.cloudCurve, uv.x.sub(0.4).abs()))))

        const cuv = uv.mul(vec2(1.0, u.stretch))
        const scroll = vec2(u.time.mul(timeSpeed), 0.0)
        const cNoise = float(0.0).toVar()
        Loop(9, ({ i }) => {
            cNoise.addAssign(circleNoise(cuv.mul(size).mul(0.3).add(float(i).add(11.0)).add(scroll), u.seed, size))
        })
        const c = fbm(cuv.mul(size).add(cNoise).add(scroll), u.seed, size).toVar()

        const col = vec4(u.colors[0]).toVar()
        If(c.lessThan(u.cloudCover.add(0.03)), () => { col.assign(u.colors[1]) })
        If(dLight.add(c.mul(0.2)).greaterThan(u.lightBorder1), () => { col.assign(u.colors[2]) })
        If(dLight.add(c.mul(0.2)).greaterThan(u.lightBorder2), () => { col.assign(u.colors[3]) })

        return vec4(col.xyz, step(u.cloudCover, c).mul(alpha).mul(col.w))
    })

    const material = new MeshBasicNodeMaterial({ transparent: true })
    material.fragmentNode = fragment()
    return new Mesh(new PlaneGeometry(1, 1), material)
}
