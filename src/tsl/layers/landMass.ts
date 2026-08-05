import { Mesh, MeshBasicNodeMaterial, PlaneGeometry, Vector4 } from 'three/webgpu'
import { Fn, If, distance, float, positionGeometry, step, uniform, vec2, vec4 } from 'three/tsl'
import { circleCutout, makeFbm, pixelize, rotateUv, spherify } from '../common'
import type { IslandsUniforms } from '../planets/islands'

/* The continents. Godot canon from LandMasses.tscn:27–36 (PlanetLandmass): size 4.292,
   6 octaves, rotation +0.2. Light borders are uniforms; the fbm multipliers are magic numbers. */
const SIZE = 4.292
const fbm = makeFbm(6)
// Godot cancels time_speed out of its own scroll: rate is round(size)*2*k, k = 0.02 here
// (Planet.gd:26 get_multiplier, LandMasses.gd:32). One full noise wrap every 25 s.
const TIME_RATE = 0.16
// Deep-Fold tilts the continents off the water by a fixed 0.2 rad (LandMasses.tscn:27)
const ROTATION_OFFSET = 0.2

/* Phase units that scroll the land one quad width. Drag-to-spin scrubs against this
   so the continents, which is what the eye tracks, follow the pointer exactly. */
export const LAND_PHASE_PER_QUAD = SIZE / TIME_RATE

export const createIslandsLandLayer = (u: IslandsUniforms): Mesh => {
    // Fresh Vector4s per call: uniform() stores by reference, and planets must not share
    const col1 = uniform(new Vector4(0.784314, 0.831373, 0.364706, 1))
    const col2 = uniform(new Vector4(0.388235, 0.670588, 0.247059, 1))
    const col3 = uniform(new Vector4(0.184314, 0.341176, 0.32549, 1))
    const col4 = uniform(new Vector4(0.156863, 0.207843, 0.25098, 1))

    const fragment = Fn(() => {
        const raw = positionGeometry.xy
        // Frozen pre-mutation values; see basePlanet.ts for the lazy-evaluation gotcha
        const uvPix = pixelize(raw, u.pixels).toVar()
        const dLight = distance(uvPix, u.lightOrigin).toVar()
        const alpha = circleCutout(uvPix).toVar()
        const uv = vec2(spherify(rotateUv(uvPix, u.rotation.add(ROTATION_OFFSET)))).toVar()

        const baseFbmUv = uv.mul(SIZE).add(vec2(u.time.mul(TIME_RATE), 0.0))
        const fbm1 = fbm(baseFbmUv, u.seedLand, float(SIZE))
        const fbm2 = fbm(baseFbmUv.sub(u.lightOrigin.mul(fbm1)), u.seedLand, float(SIZE)).toVar()
        const fbm3 = fbm(baseFbmUv.sub(u.lightOrigin.mul(1.5).mul(fbm1)), u.seedLand, float(SIZE)).toVar()
        const fbm4 = fbm(baseFbmUv.sub(u.lightOrigin.mul(2.0).mul(fbm1)), u.seedLand, float(SIZE)).toVar()

        const border1 = u.lightBordersLand.x
        const border2 = u.lightBordersLand.y
        If(dLight.lessThan(border1), () => { fbm4.mulAssign(0.9) })
        If(dLight.greaterThan(border1), () => {
            fbm2.mulAssign(1.05); fbm3.mulAssign(1.05); fbm4.mulAssign(1.05)
        })
        If(dLight.greaterThan(border2), () => {
            fbm2.mulAssign(1.3); fbm3.mulAssign(1.4); fbm4.mulAssign(1.8)
        })

        const dContrast = dLight.pow(2.0).mul(0.1)
        const col = vec4(col4).toVar()
        If(fbm4.add(dContrast).lessThan(fbm1), () => { col.assign(col3) })
        If(fbm3.add(dContrast).lessThan(fbm1), () => { col.assign(col2) })
        If(fbm2.add(dContrast).lessThan(fbm1), () => { col.assign(col1) })

        return vec4(col.xyz, step(u.landCutoff, fbm1).mul(alpha).mul(col.w))
    })

    const material = new MeshBasicNodeMaterial({ transparent: true })
    material.fragmentNode = fragment()
    return new Mesh(new PlaneGeometry(1, 1), material)
}
