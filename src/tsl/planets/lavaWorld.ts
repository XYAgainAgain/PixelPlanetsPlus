import { Group, Vector2 } from 'three/webgpu'
import { uniform } from 'three/tsl'
import { convertSeed } from '../../rng'
import { getMultiplier } from '../common'
import { PLANETS } from '../values'
import { createGroundLayer, createGroundUniforms } from '../layers/ground'
import { createCratersLayer, createCratersUniforms } from '../layers/craters'
import { createLavaRiversLayer, createLavaRiversUniforms } from '../layers/lavaRivers'

const [LAND, CRATERS, LAVA_RIVERS] = PLANETS.lavaWorld.layers

const LAND_TIME = getMultiplier(LAND.size, LAND.timeSpeed) * LAND.timeK
const CRATERS_TIME = getMultiplier(CRATERS.size, CRATERS.timeSpeed) * CRATERS.timeK
const LAVA_RIVERS_TIME = getMultiplier(LAVA_RIVERS.size, LAVA_RIVERS.timeSpeed) * LAVA_RIVERS.timeK

export const createLavaWorldUniforms = (rootSeed: number) => {
    const shared = {
        pixels: uniform(LAND.pixels),
        rotation: uniform(0.0),
        lightOrigin: uniform(new Vector2(...LAND.lightOrigin)),
        seed: uniform(convertSeed(rootSeed)),
    }
    const land = createGroundUniforms(LAND, shared)
    const craters = createCratersUniforms(CRATERS, shared)
    const lavaRivers = createLavaRiversUniforms(LAVA_RIVERS, shared)
    return { ...shared, land, craters, lavaRivers }
}
export type LavaWorldUniforms = ReturnType<typeof createLavaWorldUniforms>

export const reseedLavaWorld = (u: LavaWorldUniforms, rootSeed: number): void => {
    u.seed.value = convertSeed(rootSeed)
}

export const updateLavaWorldTime = (u: LavaWorldUniforms, t: number): void => {
    u.land.time.value = t * LAND_TIME
    u.craters.time.value = t * CRATERS_TIME
    u.lavaRivers.time.value = t * LAVA_RIVERS_TIME
}

export const createLavaWorld = (rootSeed: number) => {
    const uniforms = createLavaWorldUniforms(rootSeed)
    const planet = new Group()
    const layers = [
        createGroundLayer(LAND, uniforms.land),
        createCratersLayer(CRATERS, uniforms.craters),
        createLavaRiversLayer(LAVA_RIVERS, uniforms.lavaRivers),
    ]
    layers.forEach((mesh, i) => { mesh.renderOrder = i })
    planet.add(...layers)
    return { group: planet, uniforms }
}
