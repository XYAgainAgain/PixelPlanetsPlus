import { Group, Vector2, Vector4 } from 'three/webgpu'
import { uniform } from 'three/tsl'
import { createRng, deriveSeed, layerSeed } from '../../rng'
import { createIslandsBaseLayer } from '../layers/basePlanet'
import { createIslandsLandLayer } from '../layers/landMass'
import { createIslandsCloudLayer } from '../layers/cloudLayer'
import { createIslandsAtmosphereLayer } from '../layers/atmosphereLayer'

/* Godot rerolls cloud_cover per seed (LandMasses.gd:22), so the tscn's 0.415 never
   survives to the screen; derive it here or the same seed URL wouldn't replay. */
const cloudCoverForSeed = (rootSeed: number): number =>
    0.35 + createRng(deriveSeed(rootSeed, 3)).next() * 0.25

/* One uniform bundle drives all four layers so panel controls hit everything at once */
export const createIslandsUniforms = (rootSeed: number) => ({
    pixels: uniform(100.0),
    // Axial tilt, Godot's "Rotation" slider; the land layer adds its own +0.2 offset
    rotation: uniform(0.0),
    time: uniform(0.0),
    // Godot's (0.39, 0.39) through our y-up flip; the disc is lit from the upper left
    lightOrigin: uniform(new Vector2(0.39, 0.61)),
    lightIntensity: uniform(0.1),
    landCutoff: uniform(0.633),
    cloudCover: uniform(cloudCoverForSeed(rootSeed)),
    stretch: uniform(2.0),
    // Deep-Fold tuned these per layer in LandMasses.tscn:15–16, 31–32, 49–50
    lightBordersBase: uniform(new Vector2(0.4, 0.6)),
    lightBordersLand: uniform(new Vector2(0.32, 0.534)),
    lightBordersClouds: uniform(new Vector2(0.52, 0.62)),
    // The atmosphere is the JS port's invention with no Godot ancestor, so these borders are
    // mine: 0.4/0.6 matches the water beneath it so the rim's terminator lines up with the disc.
    lightBordersAtmo: uniform(new Vector2(0.4, 0.6)),
    seedBase: uniform(layerSeed(rootSeed, 0)),
    seedLand: uniform(layerSeed(rootSeed, 1)),
    seedClouds: uniform(layerSeed(rootSeed, 2)),
})
export type IslandsUniforms = ReturnType<typeof createIslandsUniforms>

export const reseedIslands = (u: IslandsUniforms, rootSeed: number): void => {
    u.seedBase.value = layerSeed(rootSeed, 0)
    u.seedLand.value = layerSeed(rootSeed, 1)
    u.seedClouds.value = layerSeed(rootSeed, 2)
    u.cloudCover.value = cloudCoverForSeed(rootSeed)
}

export const createIslands = (rootSeed: number) => {
    const uniforms = createIslandsUniforms(rootSeed)
    const islands = new Group()

    // Fresh Vector4s per call (uniform() stores by reference); water palette from LandMasses.tscn:17
    const baseColors = [
        new Vector4(0.572549, 0.909804, 0.752941, 1),
        new Vector4(0.309804, 0.643137, 0.721569, 1),
        new Vector4(0.172549, 0.207843, 0.301961, 1),
    ]
    const layers = [
        createIslandsBaseLayer(uniforms, baseColors),
        createIslandsLandLayer(uniforms),
        createIslandsCloudLayer(uniforms),
        createIslandsAtmosphereLayer(uniforms),
    ]
    // Transparent quads share z=0; explicit renderOrder pins the legacy stacking
    layers.forEach((mesh, i) => { mesh.renderOrder = i })
    islands.add(...layers)

    return { group: islands, uniforms }
}
