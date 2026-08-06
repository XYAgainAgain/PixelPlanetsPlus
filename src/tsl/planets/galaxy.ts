import { Group } from 'three/webgpu'
import { uniform } from 'three/tsl'
import { convertSeed } from '../../rng'
import { getMultiplier } from '../common'
import { PLANETS } from '../values'
import { createGalaxyLayer, createGalaxyUniforms as createGalaxyLayerUniforms } from '../layers/galaxy'

export const galaxyMetadata = PLANETS.galaxy
const [GALAXY] = galaxyMetadata.layers

const GALAXY_TIME = getMultiplier(GALAXY.size, GALAXY.timeSpeed) * GALAXY.timeK

export const createGalaxyUniforms = (rootSeed: number) => {
    const shared = {
        pixels: uniform(200.0),
        rotation: uniform(0.0),
        seed: uniform(convertSeed(rootSeed)),
    }
    const galaxy = createGalaxyLayerUniforms(GALAXY, shared)
    return { ...shared, galaxy }
}
export type GalaxyUniforms = ReturnType<typeof createGalaxyUniforms>

export const reseedGalaxy = (u: GalaxyUniforms, rootSeed: number): void => {
    u.seed.value = convertSeed(rootSeed)
}

export const updateGalaxyTime = (u: GalaxyUniforms, t: number): void => {
    u.galaxy.time.value = t * GALAXY_TIME
}

export const createGalaxy = (rootSeed: number) => {
    const uniforms = createGalaxyUniforms(rootSeed)
    const galaxy = new Group()
    const layer = createGalaxyLayer(GALAXY, uniforms.galaxy)
    layer.renderOrder = 0
    galaxy.add(layer)
    return { group: galaxy, uniforms }
}
