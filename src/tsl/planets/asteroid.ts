import { Group, Vector2 } from 'three/webgpu'
import { uniform } from 'three/tsl'
import { convertSeed } from '../../rng'
import {
    createAsteroidLayer,
    createAsteroidUniforms as createAsteroidLayerUniforms,
} from '../layers/asteroid'
import { PLANETS } from '../values'

export const asteroidMetadata = PLANETS.asteroid
const [ASTEROID] = asteroidMetadata.layers

export const createAsteroidUniforms = (rootSeed: number) => {
    const shared = {
        pixels: uniform(100.0),
        rotation: uniform(0.0),
        lightOrigin: uniform(new Vector2(...ASTEROID.lightOrigin)),
        seed: uniform(convertSeed(rootSeed)),
    }
    const asteroid = createAsteroidLayerUniforms(ASTEROID, shared)
    return { ...shared, asteroid }
}
export type AsteroidUniforms = ReturnType<typeof createAsteroidUniforms>

export const reseedAsteroid = (u: AsteroidUniforms, rootSeed: number): void => {
    u.seed.value = convertSeed(rootSeed)
}

export const updateAsteroidTime = (_u: AsteroidUniforms, _t: number): void => {}

export const setAsteroidCustomTime = (u: AsteroidUniforms, t: number): void => {
    u.rotation.value = t * Math.PI * 2.0
}

export const createAsteroid = (rootSeed: number) => {
    const uniforms = createAsteroidUniforms(rootSeed)
    const asteroid = new Group()
    asteroid.add(createAsteroidLayer(ASTEROID, uniforms.asteroid))

    return { group: asteroid, uniforms }
}
