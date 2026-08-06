import { Mesh, MeshBasicNodeMaterial, PlaneGeometry, Vector4 } from 'three/webgpu'
import {
    Fn, If, Loop, clamp, dot, float, floor, fract, min, mod, sin, sqrt,
    uniform, vec2, vec4,
} from 'three/tsl'
import { circleCutout, ditherCheck, pixelize, planetUv, rotateUv, spherify } from '../common'
import type { NF, NV2, UF } from '../common'
import type { LayerValues } from '../values'

/* Star/Star.gdshader: the cellular, posterized stellar disc. */

export interface StarSurfaceSharedUniforms {
    pixels: UF
    rotation: UF
    seed: UF
}

export const createStarSurfaceUniforms = (v: LayerValues, shared: StarSurfaceSharedUniforms) => ({
    ...shared,
    time: uniform(0.0),
    shouldDither: uniform(v.shouldDither === false ? 0.0 : 1.0),
    colors: v.colors.map((c) => uniform(new Vector4(...c))),
})
export type StarSurfaceUniforms = ReturnType<typeof createStarSurfaceUniforms>

const makeCells = (tiles: number) => Fn(([pIn, numCells]: [NV2, NF]) => {
    const p = pIn.mul(numCells)
    const d = float(1.0e10).toVar()
    // One flat loop over the 3×3 neighborhood: nested Loop() calls both name their counter
    // `i`, so the inner shadowed the outer and the scan collapsed to the diagonal (grid bug).
    Loop(9, ({ i }) => {
        const offset = vec2(float(i.div(3)).sub(1.0), float(i.mod(3)).sub(1.0))
        const tp = floor(p).add(offset).toVar()
        const wrapped = mod(tp, numCells.div(tiles)).toVar()
        const r = float(523.0).mul(sin(dot(wrapped, vec2(53.3158, 43.6143))))
        const hash = vec2(fract(r.mul(15.32354)), fract(r.mul(17.25865)))
        tp.assign(p.sub(tp).sub(hash))
        d.assign(min(d, dot(tp, tp)))
    })
    return sqrt(d)
})

export const createStarSurfaceLayer = (v: LayerValues, u: StarSurfaceUniforms): Mesh => {
    const cells = makeCells(v.tiles ?? 1.0)
    const timeSpeed = float(v.timeSpeed ?? 0.05)
    const nColors = v.nColors ?? 4
    const rotationOffset = v.rotationOffset ?? 0.0

    const fragment = Fn(() => {
        const raw = planetUv().toVar()
        const uv = pixelize(raw, u.pixels).toVar()
        const alpha = circleCutout(uv).toVar()
        const dith = ditherCheck(uv, raw, u.pixels).toVar()

        uv.assign(rotateUv(uv, u.rotation.add(rotationOffset)))
        uv.assign(spherify(uv))

        const n = cells(uv.sub(vec2(u.time.mul(timeSpeed).mul(2.0), 0.0)), float(10.0))
            .mul(cells(uv.sub(vec2(u.time.mul(timeSpeed), 0.0)), float(20.0)))
            .mul(2.0).toVar()
        n.assign(clamp(n, 0.0, 1.0))
        If(dith.or(u.shouldDither.lessThan(0.5)), () => { n.mulAssign(1.3) })

        const steps = float(nColors - 1)
        const index = floor(n.mul(steps)).toVar()
        const col = vec4(u.colors[0]).toVar()
        If(index.greaterThanEqual(1.0), () => { col.assign(u.colors[1]) })
        If(index.greaterThanEqual(2.0), () => { col.assign(u.colors[2]) })
        If(index.greaterThanEqual(3.0), () => { col.assign(u.colors[3]) })

        return vec4(col.xyz, alpha.mul(col.w))
    })

    const material = new MeshBasicNodeMaterial({ transparent: true })
    material.fragmentNode = fragment()
    return new Mesh(new PlaneGeometry(1, 1), material)
}
