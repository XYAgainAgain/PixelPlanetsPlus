import { Group, Vector2 } from 'three/webgpu'
import { uniform } from 'three/tsl'
import { convertSeed } from '../../rng'
import { getMultiplier } from '../common'
import { PLANETS } from '../values'
import { createGroundLayer, createGroundUniforms } from '../layers/ground'
import { createCratersLayer, createCratersUniforms } from '../layers/craters'

const [GROUND, CRATERS] = PLANETS.noAtmosphere.layers

const GROUND_TIME = getMultiplier(GROUND.size, GROUND.timeSpeed) * GROUND.timeK
const CRATERS_TIME = getMultiplier(CRATERS.size, CRATERS.timeSpeed) * CRATERS.timeK

export const createNoAtmosphereUniforms = (rootSeed: number) => {
    const shared = {
        pixels: uniform(GROUND.pixels),
        rotation: uniform(0.0),
        lightOrigin: uniform(new Vector2(...GROUND.lightOrigin)),
        seed: uniform(convertSeed(rootSeed)),
    }
    const ground = createGroundUniforms(GROUND, shared)
    const craters = createCratersUniforms(CRATERS, shared)
    return { ...shared, ground, craters }
}
export type NoAtmosphereUniforms = ReturnType<typeof createNoAtmosphereUniforms>

export const reseedNoAtmosphere = (u: NoAtmosphereUniforms, rootSeed: number): void => {
    u.seed.value = convertSeed(rootSeed)
}

export const updateNoAtmosphereTime = (u: NoAtmosphereUniforms, t: number): void => {
    u.ground.time.value = t * GROUND_TIME
    u.craters.time.value = t * CRATERS_TIME
}

export const createNoAtmosphere = (rootSeed: number) => {
    const uniforms = createNoAtmosphereUniforms(rootSeed)
    const planet = new Group()
    const layers = [
        createGroundLayer(GROUND, uniforms.ground),
        createCratersLayer(CRATERS, uniforms.craters),
    ]
    layers.forEach((mesh, i) => { mesh.renderOrder = i })
    planet.add(...layers)
    return { group: planet, uniforms }
}
