import { Group, Vector2 } from 'three/webgpu'
import { uniform } from 'three/tsl'
import { convertSeed } from '../../rng'
import { getMultiplier, RING_TIME_MULT } from '../common'
import { createGasLayersLayer, createGasLayersUniforms } from '../layers/gasLayers'
import { createRingLayer, createRingUniforms } from '../layers/ring'
import { PLANETS } from '../values'

export const gasGiant2Metadata = PLANETS.gasGiant2
const [GAS_LAYERS, RING] = gasGiant2Metadata.layers

const GAS_LAYERS_TIME = getMultiplier(GAS_LAYERS.size, GAS_LAYERS.timeSpeed) * GAS_LAYERS.timeK

export const createGasGiant2Uniforms = (rootSeed: number) => {
    const pixels = uniform(100.0)
    const rotation = uniform(0.0)
    const lightOrigin = uniform(new Vector2(...GAS_LAYERS.lightOrigin))
    const seed = uniform(convertSeed(rootSeed))
    const gasLayers = createGasLayersUniforms(GAS_LAYERS, { pixels, rotation, lightOrigin, seed })
    const ring = createRingUniforms(RING, { planetPixels: pixels, rotation, lightOrigin, seed })
    return { pixels, rotation, lightOrigin, seed, gasLayers, ring }
}
export type GasGiant2Uniforms = ReturnType<typeof createGasGiant2Uniforms>

export const reseedGasGiant2 = (u: GasGiant2Uniforms, rootSeed: number): void => {
    u.seed.value = convertSeed(rootSeed)
}

export const updateGasGiant2Time = (u: GasGiant2Uniforms, t: number): void => {
    u.gasLayers.time.value = t * GAS_LAYERS_TIME
    u.ring.time.value = t * RING_TIME_MULT
}

export const createGasGiant2 = (rootSeed: number) => {
    const uniforms = createGasGiant2Uniforms(rootSeed)
    const gasGiant = new Group()
    const layers = [
        createGasLayersLayer(GAS_LAYERS, uniforms.gasLayers),
        createRingLayer(RING, uniforms.ring),
    ]
    layers.forEach((mesh, i) => { mesh.renderOrder = i })
    gasGiant.add(...layers)
    return { group: gasGiant, uniforms }
}
