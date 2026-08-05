import { Mesh, MeshBasicNodeMaterial, PlaneGeometry, Vector4 } from 'three/webgpu'
import { Fn, If, Loop, distance, float, positionGeometry, smoothstep, step, uniform, vec2, vec4 } from 'three/tsl'
import { circleCutout, circleNoise, makeFbm, pixelize, rotateUv, spherify } from '../common'
import type { IslandsUniforms } from '../planets/islands'

/* Godot canon from LandMasses.tscn:44–53 (Clouds): size 7.745, 2 octaves, 9 turbulence
   iterations, cloud_curve 1.3. Light borders, cover, and stretch are uniforms. */
const SIZE = 7.745
const fbm = makeFbm(2)
// Godot cancels time_speed out of its own scroll: rate is round(size)*2*k, k = 0.01 here
// (Planet.gd:26 get_multiplier, LandMasses.gd:30), so clouds wrap at half the surface's pace.
const TIME_RATE = 0.16

export const createIslandsCloudLayer = (u: IslandsUniforms): Mesh => {
    // Fresh Vector4s per call: uniform() stores by reference, and planets must not share
    const baseColor = uniform(new Vector4(0.87451, 0.878431, 0.909804, 1))
    const outlineColor = uniform(new Vector4(0.639216, 0.654902, 0.760784, 1))
    const shadowBase = uniform(new Vector4(0.407843, 0.435294, 0.6, 1))
    const shadowOutline = uniform(new Vector4(0.25098, 0.286275, 0.45098, 1))

    const fragment = Fn(() => {
        const raw = positionGeometry.xy
        // Frozen pre-mutation values; see basePlanet.ts for the lazy-evaluation gotcha
        const uvPix = pixelize(raw, u.pixels).toVar()
        const dLight = distance(uvPix, u.lightOrigin).toVar()
        const alpha = circleCutout(uvPix).toVar()
        const dToCenter = distance(uvPix, vec2(0.5)).toVar()
        const uv = vec2(spherify(rotateUv(uvPix, u.rotation))).toVar()
        // Slight vertical droop toward the edges gives clouds their banded curve
        uv.assign(vec2(uv.x, uv.y.add(smoothstep(0.0, 1.3, uv.x.sub(0.4).abs()))))

        const cuv = uv.mul(vec2(1.0, u.stretch))
        const scroll = vec2(u.time.mul(TIME_RATE), 0.0)

        const cNoise = float(0.0).toVar()
        Loop(9, ({ i }) => {
            cNoise.addAssign(circleNoise(cuv.mul(SIZE).mul(0.3).add(float(i).add(11.0)).add(scroll), u.seedClouds, float(SIZE)))
        })
        const c = fbm(cuv.mul(SIZE).add(cNoise).add(scroll), u.seedClouds, float(SIZE)).toVar()

        const col = vec4(baseColor).toVar()
        If(c.lessThan(u.cloudCover.add(0.03)), () => { col.assign(outlineColor) })
        If(dLight.add(c.mul(0.2)).greaterThan(u.lightBordersClouds.x), () => { col.assign(shadowBase) })
        If(dLight.add(c.mul(0.2)).greaterThan(u.lightBordersClouds.y), () => { col.assign(shadowOutline) })

        // Godot cuts the cloud field at a flat 0.5 here, unlike the 0.49999 disc alpha above
        c.mulAssign(step(dToCenter, 0.5))
        return vec4(col.xyz, step(u.cloudCover, c).mul(alpha).mul(col.w))
    })

    const material = new MeshBasicNodeMaterial({ transparent: true })
    material.fragmentNode = fragment()
    return new Mesh(new PlaneGeometry(1, 1), material)
}
