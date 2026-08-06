import { Group, Vector2 } from 'three/webgpu'
import { uniform } from 'three/tsl'
import { convertSeed } from '../../rng'
import { getMultiplier } from '../common'
import { createDryTerranLayer, createDryTerranUniforms } from '../layers/dryTerran'
import { PLANETS } from '../values'

export const terranDryMetadata = PLANETS.terranDry
const [LAND] = terranDryMetadata.layers

const LAND_TIME = getMultiplier(LAND.size, LAND.timeSpeed) * LAND.timeK

export const createTerranDryUniforms = (rootSeed: number) => {
    const shared = {
        pixels: uniform(100.0),
        rotation: uniform(0.0),
        lightOrigin: uniform(new Vector2(...LAND.lightOrigin)),
        seed: uniform(convertSeed(rootSeed)),
    }
    const land = createDryTerranUniforms(LAND, shared)
    return { ...shared, land }
}
export type TerranDryUniforms = ReturnType<typeof createTerranDryUniforms>

export const reseedTerranDry = (u: TerranDryUniforms, rootSeed: number): void => {
    u.seed.value = convertSeed(rootSeed)
}

export const updateTerranDryTime = (u: TerranDryUniforms, t: number): void => {
    u.land.time.value = t * LAND_TIME
}

export const createTerranDry = (rootSeed: number) => {
    const uniforms = createTerranDryUniforms(rootSeed)
    const terranDry = new Group()
    terranDry.add(createDryTerranLayer(LAND, uniforms.land))

    return { group: terranDry, uniforms }
}
