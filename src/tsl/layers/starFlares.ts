import { Mesh, MeshBasicNodeMaterial, PlaneGeometry, Vector4 } from 'three/webgpu'
import { Fn, If, atan, distance, float, floor, mod, smoothstep, step, uniform, vec2, vec4, clamp } from 'three/tsl'
import { ditherCheck, makeFbm, makeRand, pixelize, planetUv, rotateUv } from '../common'
import type { NF, NV2, UF } from '../common'
import type { LayerValues } from '../values'

/* Star/StarFlares.gdshader: the oversized, outward-moving flare layer. */

export interface StarFlaresSharedUniforms {
    pixels: UF
    rotation: UF
    seed: UF
}

export const createStarFlaresUniforms = (v: LayerValues, shared: StarFlaresSharedUniforms) => ({
    ...shared,
    time: uniform(0.0),
    shouldDither: uniform(v.shouldDither === false ? 0.0 : 1.0),
    stormWidth: uniform(v.stormWidth ?? 0.3),
    stormDitherWidth: uniform(v.stormDitherWidth ?? 0.0),
    colors: v.colors.map((c) => uniform(new Vector4(...c))),
})
export type StarFlaresUniforms = ReturnType<typeof createStarFlaresUniforms>

const makeFlareCircle = (circleAmount: number, circleScale: number, rand: ReturnType<typeof makeRand>) =>
    Fn(([uvIn, seed, size]: [NV2, NF, NF]) => {
        const uv = vec2(uvIn).toVar()
        const invert = float(1.0 / circleAmount)
        If(mod(uv.y, invert.mul(2.0)).lessThan(invert), () => {
            uv.assign(vec2(uv.x.add(invert.mul(0.5)), uv.y))
        })
        const randCo = floor(uv.mul(circleAmount)).div(circleAmount)
        uv.assign(mod(uv, invert).mul(circleAmount))
        const r = clamp(rand(randCo, seed, size), invert, float(1.0).sub(invert))
        const circleDistance = distance(uv, vec2(r))
        return smoothstep(
            circleDistance,
            circleDistance.add(0.5),
            invert.mul(circleScale).mul(rand(randCo.mul(1.5), seed, size)),
        )
    })

export const createStarFlaresLayer = (v: LayerValues, u: StarFlaresUniforms): Mesh => {
    const spec = v.noise ?? { hash: 15.5453, tiling: 'simple' as const }
    const rand = makeRand(spec)
    const fbm = makeFbm(v.octaves ?? 4, spec)
    const circle = makeFlareCircle(v.circleAmount ?? 2.0, v.circleScale ?? 1.0, rand)
    const size = float(v.size ?? 1.6)
    const timeSpeed = float(v.timeSpeed ?? 0.05)
    const scale = float(v.scale ?? 1.0)
    const rotationOffset = v.rotationOffset ?? 0.0

    const fragment = Fn(() => {
        const raw = planetUv().toVar()
        const pixelized = pixelize(raw, u.pixels).toVar()
        const dith = ditherCheck(raw, pixelized, u.pixels).toVar()
        pixelized.assign(rotateUv(pixelized, u.rotation.add(rotationOffset)))
        const uv = vec2(pixelized).toVar()
        const angle = atan(uv.x.sub(0.5), uv.y.sub(0.5)).mul(0.4).toVar()
        const d = distance(pixelized, vec2(0.5)).toVar()
        const circleUv = vec2(d, angle)

        const n = fbm(circleUv.mul(size).sub(u.time.mul(timeSpeed)), u.seed, size).toVar()
        const nc = circle(circleUv.mul(scale).sub(u.time.mul(timeSpeed)).add(n), u.seed, size).mul(1.5).toVar()
        const n2 = fbm(circleUv.mul(size).sub(u.time).add(vec2(100.0)), u.seed, size).toVar()
        nc.subAssign(n2.mul(0.1))

        const alpha = float(0.0).toVar()
        If(float(1.0).sub(d).greaterThan(nc), () => {
            If(nc.greaterThan(u.stormWidth.sub(u.stormDitherWidth).add(d))
                .and(dith.or(u.shouldDither.lessThan(0.5))), () => {
                alpha.assign(1.0)
            }).ElseIf(nc.greaterThan(u.stormWidth.add(d)), () => {
                alpha.assign(1.0)
            })
        })

        const index = floor(n2.add(nc))
        const col = vec4(u.colors[0]).toVar()
        If(index.greaterThanEqual(1.0), () => { col.assign(u.colors[1]) })
        alpha.mulAssign(step(n2.mul(0.25), d))
        return vec4(col.xyz, alpha.mul(col.w))
    })

    const material = new MeshBasicNodeMaterial({ transparent: true })
    material.fragmentNode = fragment()
    return new Mesh(new PlaneGeometry(1, 1), material)
}
