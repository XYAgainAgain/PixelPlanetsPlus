import { Group, Vector2 } from 'three/webgpu'
import { uniform } from 'three/tsl'
import { convertSeed } from '../../rng'
import { getMultiplier } from '../common'
import { PLANETS } from '../values'
import { createPlanetUnderLayer, createPlanetUnderUniforms } from '../layers/planetUnder'
import { createLakesLayer, createLakesUniforms } from '../layers/lakes'
import { createCloudLayer, createCloudUniforms } from '../layers/cloudLayer'

const [LAND, LAKES, CLOUDS] = PLANETS.iceWorld.layers

const LAND_TIME = getMultiplier(LAND.size, LAND.timeSpeed) * LAND.timeK
const LAKES_TIME = getMultiplier(LAKES.size, LAKES.timeSpeed) * LAKES.timeK
const CLOUDS_TIME = getMultiplier(CLOUDS.size, CLOUDS.timeSpeed) * CLOUDS.timeK

export const createIceWorldUniforms = (rootSeed: number) => {
    const shared = {
        pixels: uniform(LAND.pixels),
        rotation: uniform(0.0),
        lightOrigin: uniform(new Vector2(...LAND.lightOrigin)),
        seed: uniform(convertSeed(rootSeed)),
    }
    const land = createPlanetUnderUniforms(LAND, shared)
    const lakes = createLakesUniforms(LAKES, shared)
    const clouds = createCloudUniforms(CLOUDS, shared)
    return { ...shared, land, lakes, clouds }
}
export type IceWorldUniforms = ReturnType<typeof createIceWorldUniforms>

export const reseedIceWorld = (u: IceWorldUniforms, rootSeed: number): void => {
    u.seed.value = convertSeed(rootSeed)
}

export const updateIceWorldTime = (u: IceWorldUniforms, t: number): void => {
    u.land.time.value = t * LAND_TIME
    u.lakes.time.value = t * LAKES_TIME
    u.clouds.time.value = t * CLOUDS_TIME
}

export const createIceWorld = (rootSeed: number) => {
    const uniforms = createIceWorldUniforms(rootSeed)
    const planet = new Group()
    const layers = [
        createPlanetUnderLayer(LAND, uniforms.land),
        createLakesLayer(LAKES, uniforms.lakes),
        createCloudLayer(CLOUDS, uniforms.clouds),
    ]
    layers.forEach((mesh, i) => { mesh.renderOrder = i })
    planet.add(...layers)
    return { group: planet, uniforms }
}
