import { Group } from 'three/webgpu'
import { uniform } from 'three/tsl'
import { convertSeed } from '../../rng'
import { PLANETS } from '../values'
import { createBlackHoleCoreLayer, createBlackHoleCoreUniforms } from '../layers/blackHoleCore'
import { createAccretionDiskLayer, createAccretionDiskUniforms } from '../layers/accretionDisk'

export const blackHoleMetadata = PLANETS.blackHole
const [CORE, DISK] = blackHoleMetadata.layers

const DISK_TIME = 314.15 * 0.004

export const createBlackHoleUniforms = (rootSeed: number) => {
    const pixels = uniform(100.0)
    const rotation = uniform(0.0)
    const seed = uniform(convertSeed(rootSeed))
    const core = createBlackHoleCoreUniforms(CORE, { pixels })
    const disk = createAccretionDiskUniforms(DISK, { planetPixels: pixels, rotation, seed })
    return { pixels, rotation, seed, core, disk }
}
export type BlackHoleUniforms = ReturnType<typeof createBlackHoleUniforms>

export const reseedBlackHole = (u: BlackHoleUniforms, rootSeed: number): void => {
    u.seed.value = convertSeed(rootSeed)
}

export const updateBlackHoleTime = (u: BlackHoleUniforms, t: number): void => {
    u.disk.time.value = t * DISK_TIME
}

export const createBlackHole = (rootSeed: number) => {
    const uniforms = createBlackHoleUniforms(rootSeed)
    const blackHole = new Group()
    const layers = [
        createBlackHoleCoreLayer(CORE, uniforms.core),
        createAccretionDiskLayer(DISK, uniforms.disk),
    ]
    layers.forEach((mesh, i) => { mesh.renderOrder = i })
    blackHole.add(...layers)
    return { group: blackHole, uniforms }
}
