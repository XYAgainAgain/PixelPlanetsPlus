import { Group, Vector2 } from 'three/webgpu'
import { uniform } from 'three/tsl'
import { convertSeed, createRng, deriveSeed } from '../../rng'
import { getMultiplier } from '../common'
import { createCloudLayer, createCloudUniforms } from '../layers/cloudLayer'
import { createLandRiversLayer, createLandRiversUniforms } from '../layers/landRivers'
import { PLANETS } from '../values'

export const terranWetMetadata = PLANETS.terranWet
const [LAND, CLOUD] = terranWetMetadata.layers

const LAND_TIME = getMultiplier(LAND.size, LAND.timeSpeed) * LAND.timeK
const CLOUD_TIME = getMultiplier(CLOUD.size, CLOUD.timeSpeed) * CLOUD.timeK

const cloudCoverForSeed = (rootSeed: number): number => {
    const [lo, hi] = CLOUD.cloudCoverRange
    return lo + createRng(deriveSeed(rootSeed, 2)).next() * (hi - lo)
}

export const createTerranWetUniforms = (rootSeed: number) => {
    const shared = {
        pixels: uniform(100.0),
        rotation: uniform(0.0),
        lightOrigin: uniform(new Vector2(...LAND.lightOrigin)),
        seed: uniform(convertSeed(rootSeed)),
    }
    const land = createLandRiversUniforms(LAND, shared)
    const clouds = createCloudUniforms(CLOUD, shared)
    clouds.cloudCover.value = cloudCoverForSeed(rootSeed)
    return { ...shared, land, clouds }
}
export type TerranWetUniforms = ReturnType<typeof createTerranWetUniforms>

export const reseedTerranWet = (u: TerranWetUniforms, rootSeed: number): void => {
    u.seed.value = convertSeed(rootSeed)
    u.clouds.cloudCover.value = cloudCoverForSeed(rootSeed)
}

export const updateTerranWetTime = (u: TerranWetUniforms, t: number): void => {
    u.land.time.value = t * LAND_TIME
    u.clouds.time.value = t * CLOUD_TIME
}

export const createTerranWet = (rootSeed: number) => {
    const uniforms = createTerranWetUniforms(rootSeed)
    const terranWet = new Group()
    const layers = [
        createLandRiversLayer(LAND, uniforms.land),
        createCloudLayer(CLOUD, uniforms.clouds),
    ]
    layers.forEach((mesh, i) => { mesh.renderOrder = i })
    terranWet.add(...layers)

    return { group: terranWet, uniforms }
}
