import { Group } from 'three/webgpu'
import { uniform } from 'three/tsl'
import { convertSeed } from '../../rng'
import { getMultiplier } from '../common'
import { createStarBlobsLayer, createStarBlobsUniforms } from '../layers/starBlobs'
import { createStarFlaresLayer, createStarFlaresUniforms } from '../layers/starFlares'
import { createStarSurfaceLayer, createStarSurfaceUniforms } from '../layers/starSurface'
import { PLANETS } from '../values'

export const starMetadata = PLANETS.star
const [BLOBS, SURFACE, FLARES] = starMetadata.layers

const BLOBS_TIME = getMultiplier(BLOBS.size, BLOBS.timeSpeed) * BLOBS.timeK
const SURFACE_TIME = getMultiplier(SURFACE.size, SURFACE.timeSpeed) * SURFACE.timeK
const FLARES_TIME = getMultiplier(FLARES.size, FLARES.timeSpeed) * FLARES.timeK

const ORANGE_SURFACE = [
    [0.960784, 1, 0.909804, 1], [1, 0.847059, 0.196078, 1],
    [1, 0.509804, 0.231373, 1], [0.486275, 0.0980392, 0.101961, 1],
] as const
const TEAL_SURFACE = SURFACE.colors
const ORANGE_FLARES = [[1, 0.847059, 0.196078, 1], [0.960784, 1, 0.909804, 1]] as const
const TEAL_FLARES = FLARES.colors

const applySeedPalette = (u: StarUniforms, rootSeed: number): void => {
    const surface = rootSeed % 2 === 0 ? ORANGE_SURFACE : TEAL_SURFACE
    const flares = rootSeed % 2 === 0 ? ORANGE_FLARES : TEAL_FLARES
    surface.forEach((color, i) => { u.surface.colors[i].value.set(color[0], color[1], color[2], color[3]) })
    flares.forEach((color, i) => { u.flares.colors[i].value.set(color[0], color[1], color[2], color[3]) })
}

export const createStarUniforms = (rootSeed: number) => {
    const pixels = uniform(100.0)
    const rotation = uniform(0.0)
    const seed = uniform(convertSeed(rootSeed))
    const blobs = createStarBlobsUniforms(BLOBS, { planetPixels: pixels, rotation, seed })
    const surface = createStarSurfaceUniforms(SURFACE, { pixels, rotation, seed })
    const flares = createStarFlaresUniforms(FLARES, { planetPixels: pixels, rotation, seed })
    const uniforms = { pixels, rotation, seed, blobs, surface, flares }
    applySeedPalette(uniforms, rootSeed)
    return uniforms
}
export type StarUniforms = ReturnType<typeof createStarUniforms>

export const reseedStar = (u: StarUniforms, rootSeed: number): void => {
    u.seed.value = convertSeed(rootSeed)
    applySeedPalette(u, rootSeed)
}

export const updateStarTime = (u: StarUniforms, t: number): void => {
    u.blobs.time.value = t * BLOBS_TIME
    u.surface.time.value = t * SURFACE_TIME
    u.flares.time.value = t * FLARES_TIME
}

export const createStar = (rootSeed: number) => {
    const uniforms = createStarUniforms(rootSeed)
    const star = new Group()
    const layers = [
        createStarBlobsLayer(BLOBS, uniforms.blobs),
        createStarSurfaceLayer(SURFACE, uniforms.surface),
        createStarFlaresLayer(FLARES, uniforms.flares),
    ]
    layers.forEach((mesh, i) => { mesh.renderOrder = i })
    star.add(...layers)
    return { group: star, uniforms }
}
