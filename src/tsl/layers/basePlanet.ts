import { Mesh, MeshBasicNodeMaterial, PlaneGeometry, Vector4 } from 'three/webgpu'
import { Fn, If, distance, float, positionGeometry, uniform, vec2, vec4 } from 'three/tsl'
import { circleCutout, ditherCheck, makeFbm, pixelize, rotateUv } from '../common'
import type { IslandsUniforms } from '../planets/islands'

/* The water disc. Godot canon from LandMasses.tscn:18–19 (PlanetUnder): size 5.228, 3 octaves,
   dither size 2, should_dither folded to true. Light borders are uniforms. */
const SIZE = 5.228
const fbm = makeFbm(3)
// Godot cancels time_speed out of its own scroll: rate is round(size)*2*k, k = 0.02 here
// (Planet.gd:26 get_multiplier, LandMasses.gd:31). One full noise wrap every 25 s.
const TIME_RATE = 0.2

export const createIslandsBaseLayer = (u: IslandsUniforms, colors: Vector4[]): Mesh => {
    const color1 = uniform(colors[0])
    const color2 = uniform(colors[1])
    const color3 = uniform(colors[2])

    const fragment = Fn(() => {
        const raw = positionGeometry.xy
        // uvPix is frozen pre-mutation: TSL inlines lazily, so distances must not read the
        // mutated var or they evaluate post-rotate/spherify, unlike the GLSL statement order
        const uvPix = pixelize(raw, u.pixels).toVar()
        const dLight = distance(uvPix, u.lightOrigin).toVar()
        const alpha = circleCutout(uvPix).toVar()
        const dith = ditherCheck(uvPix, raw, u.pixels).toVar()
        const uv = vec2(rotateUv(uvPix, u.rotation)).toVar()

        const fbm1 = fbm(uv, u.seedBase, float(SIZE))
        const scroll = vec2(u.time.mul(TIME_RATE), 0.0)
        dLight.addAssign(fbm(uv.mul(SIZE).add(fbm1).add(scroll), u.seedBase, float(SIZE)).mul(u.lightIntensity))

        const ditherBorder = float(1.0).div(u.pixels).mul(2.0)
        const border1 = u.lightBordersBase.x
        const border2 = u.lightBordersBase.y
        const col = vec4(color1).toVar()
        If(dLight.greaterThan(border1), () => {
            col.assign(color2)
            If(dLight.lessThan(ditherBorder.add(border1)).and(dith), () => { col.assign(color1) })
        })
        If(dLight.greaterThan(border2), () => {
            col.assign(color3)
            If(dLight.lessThan(ditherBorder.add(border2)).and(dith), () => { col.assign(color2) })
        })

        return vec4(col.xyz, alpha.mul(col.w))
    })

    const material = new MeshBasicNodeMaterial({ transparent: true })
    material.fragmentNode = fragment()
    return new Mesh(new PlaneGeometry(1, 1), material)
}
