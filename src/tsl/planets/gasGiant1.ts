import { Group, Vector2 } from 'three/webgpu'
import { uniform } from 'three/tsl'
import { convertSeed, createRng, deriveSeed } from '../../rng'
import { getMultiplier } from '../common'
import { createGasPlanetLayer, createGasPlanetUniforms } from '../layers/gasPlanet'
import { PLANETS } from '../values'

export const gasGiant1Metadata = PLANETS.gasGiant1
const [CLOUD, CLOUD2] = gasGiant1Metadata.layers

const CLOUD_TIME = getMultiplier(CLOUD.size, CLOUD.timeSpeed) * CLOUD.timeK
const CLOUD2_TIME = getMultiplier(CLOUD2.size, CLOUD2.timeSpeed) * CLOUD2.timeK

const cloudCoverForSeed = (rootSeed: number): number => {
    const [lo, hi] = CLOUD2.cloudCoverRange
    return lo + createRng(deriveSeed(rootSeed, 2)).next() * (hi - lo)
}

export const createGasGiant1Uniforms = (rootSeed: number) => {
    const shared = {
        pixels: uniform(100.0),
        rotation: uniform(0.0),
        lightOrigin: uniform(new Vector2(...CLOUD.lightOrigin)),
        seed: uniform(convertSeed(rootSeed)),
    }
    const cloud = createGasPlanetUniforms(CLOUD, shared)
    const cloud2 = createGasPlanetUniforms(CLOUD2, shared)
    cloud2.cloudCover.value = cloudCoverForSeed(rootSeed)
    return { ...shared, cloud, cloud2 }
}
export type GasGiant1Uniforms = ReturnType<typeof createGasGiant1Uniforms>

export const reseedGasGiant1 = (u: GasGiant1Uniforms, rootSeed: number): void => {
    u.seed.value = convertSeed(rootSeed)
    u.cloud2.cloudCover.value = cloudCoverForSeed(rootSeed)
}

export const updateGasGiant1Time = (u: GasGiant1Uniforms, t: number): void => {
    u.cloud.time.value = t * CLOUD_TIME
    u.cloud2.time.value = t * CLOUD2_TIME
}

export const createGasGiant1 = (rootSeed: number) => {
    const uniforms = createGasGiant1Uniforms(rootSeed)
    const gasGiant = new Group()
    const layers = [
        createGasPlanetLayer(CLOUD, uniforms.cloud),
        createGasPlanetLayer(CLOUD2, uniforms.cloud2),
    ]
    layers.forEach((mesh, i) => { mesh.renderOrder = i })
    gasGiant.add(...layers)
    return { group: gasGiant, uniforms }
}
