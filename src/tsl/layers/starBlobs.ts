import { Mesh, MeshBasicNodeMaterial, PlaneGeometry, Vector4 } from 'three/webgpu'
import { Fn, If, Loop, atan, clamp, distance, float, floor, mod, smoothstep, step, uniform, vec2, vec4 } from 'three/tsl'
import { makeRand, pixelize, planetUv, rotateUv } from '../common'
import type { NF, NV2, UF } from '../common'
import type { LayerValues } from '../values'

/* Star/StarBlobs.gdshader: the oversized radial blob layer around the stellar disc. */

export interface StarBlobsSharedUniforms {
    planetPixels: UF
    rotation: UF
    seed: UF
}

export const createStarBlobsUniforms = (v: LayerValues, shared: StarBlobsSharedUniforms) => ({
    ...shared,
    time: uniform(0.0),
    colors: v.colors.map((c) => uniform(new Vector4(...c))),
})
export type StarBlobsUniforms = ReturnType<typeof createStarBlobsUniforms>

const makeBlobCircle = (circleAmount: number, circleSize: number, rand: ReturnType<typeof makeRand>) =>
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
            invert.mul(circleSize).mul(rand(randCo.mul(1.5), seed, size)),
        )
    })

export const createStarBlobsLayer = (v: LayerValues, u: StarBlobsUniforms): Mesh => {
    const spec = v.noise ?? { hash: 15.5453, tiling: 'simple' as const }
    const rand = makeRand(spec)
    const circle = makeBlobCircle(v.circleAmount ?? 2.0, v.circleSize ?? 1.0, rand)
    const size = float(v.size ?? 4.93)
    const timeSpeed = float(v.timeSpeed ?? 0.05)
    const rotationOffset = v.rotationOffset ?? 0.0
    const pixelScale = v.quadScale

    const fragment = Fn(() => {
        const raw = planetUv().toVar()
        const pixelized = pixelize(raw, u.planetPixels.mul(pixelScale)).toVar()
        const uv = rotateUv(pixelized, u.rotation.add(rotationOffset)).toVar()
        const angle = atan(uv.x.sub(0.5), uv.y.sub(0.5)).toVar()
        const d = distance(pixelized, vec2(0.5)).toVar()

        const c = float(0.0).toVar()
        Loop(15, ({ i }) => {
            const r = rand(vec2(float(i)), u.seed, size)
            const circleUv = vec2(d, angle)
            c.addAssign(circle(circleUv.mul(size).sub(u.time.mul(timeSpeed)).sub(float(1.0).div(d).mul(0.1)).add(r), u.seed, size))
        })
        c.mulAssign(float(0.37).sub(d))
        c.assign(step(0.07, c.sub(d)))

        return vec4(u.colors[0].xyz, c.mul(u.colors[0].w))
    })

    const material = new MeshBasicNodeMaterial({ transparent: true })
    material.fragmentNode = fragment()
    const mesh = new Mesh(new PlaneGeometry(1, 1), material)
    mesh.scale.setScalar(v.quadScale)
    return mesh
}
