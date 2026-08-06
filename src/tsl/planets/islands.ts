import { Group, Vector2 } from 'three/webgpu'
import { uniform } from 'three/tsl'
import { convertSeed, createRng, deriveSeed } from '../../rng'
import { getMultiplier } from '../common'
import { PLANETS } from '../values'
import { createPlanetUnderLayer, createPlanetUnderUniforms } from '../layers/planetUnder'
import { createLandmassLayer, createLandmassUniforms } from '../layers/landMass'
import { createCloudLayer, createCloudUniforms } from '../layers/cloudLayer'
import { createAtmosphereLayer, createAtmosphereUniforms } from '../layers/atmosphereLayer'

const [WATER, LAND, CLOUD] = PLANETS.islands.layers

/* Godot's update_time scalar per layer (LandMasses.gd:29–32); time_speed cancels in the
   shader's time·time_speed, so each layer scrolls at round(size)·2·k per phase second. */
const WATER_TIME = getMultiplier(WATER.size, WATER.timeSpeed) * WATER.timeK
const LAND_TIME = getMultiplier(LAND.size, LAND.timeSpeed) * LAND.timeK
const CLOUD_TIME = getMultiplier(CLOUD.size, CLOUD.timeSpeed) * CLOUD.timeK

/* Phase units that scroll the land one quad width. Drag-to-spin scrubs against this
   so the continents, which is what the eye tracks, follow the pointer exactly. */
export const LAND_PHASE_PER_QUAD = LAND.size / (LAND_TIME * LAND.timeSpeed)

/* Godot rerolls cloud_cover per seed (LandMasses.gd:22), so the tscn's 0.415 never
   survives to the screen; derive it here or the same seed URL wouldn't replay. */
const cloudCoverForSeed = (rootSeed: number): number => {
    const [lo, hi] = CLOUD.cloudCoverRange
    return lo + createRng(deriveSeed(rootSeed, 3)).next() * (hi - lo)
}

/* One shared bundle fans seed, light, tilt, and pixels to every layer, Godot's set_* pattern */
export const createIslandsUniforms = (rootSeed: number) => {
    const shared = {
        pixels: uniform(100.0),
        // Axial tilt, Godot's "Rotation" slider; the land layer adds its scene +0.2 offset
        rotation: uniform(0.0),
        lightOrigin: uniform(new Vector2(...WATER.lightOrigin)),
        // Godot's converted-seed domain, one value fanned to all layers (S7)
        seed: uniform(convertSeed(rootSeed)),
    }
    const water = createPlanetUnderUniforms(WATER, shared)
    const land = createLandmassUniforms(LAND, shared)
    const clouds = createCloudUniforms(CLOUD, shared)
    clouds.cloudCover.value = cloudCoverForSeed(rootSeed)
    const atmosphere = createAtmosphereUniforms(shared)
    return { ...shared, water, land, clouds, atmosphere }
}
export type IslandsUniforms = ReturnType<typeof createIslandsUniforms>

export const reseedIslands = (u: IslandsUniforms, rootSeed: number): void => {
    u.seed.value = convertSeed(rootSeed)
    u.clouds.cloudCover.value = cloudCoverForSeed(rootSeed)
}

/* Godot feeds each layer t·get_multiplier·k every frame (Planet.gd:_process); t is our phase */
export const updateIslandsTime = (u: IslandsUniforms, t: number): void => {
    u.water.time.value = t * WATER_TIME
    u.land.time.value = t * LAND_TIME
    u.clouds.time.value = t * CLOUD_TIME
}

export const createIslands = (rootSeed: number) => {
    const uniforms = createIslandsUniforms(rootSeed)
    const islands = new Group()

    const layers = [
        createPlanetUnderLayer(WATER, uniforms.water),
        createLandmassLayer(LAND, uniforms.land),
        createCloudLayer(CLOUD, uniforms.clouds),
        createAtmosphereLayer(uniforms.atmosphere),
    ]
    // Transparent quads share z=0; explicit renderOrder pins the Godot stacking
    layers.forEach((mesh, i) => { mesh.renderOrder = i })
    islands.add(...layers)

    return { group: islands, uniforms }
}
