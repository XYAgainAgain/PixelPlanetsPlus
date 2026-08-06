import type { Group, Vector2, Vector4 } from 'three/webgpu'
import { convertSeed } from '../rng'
import { Color } from '../palette'
import { createPaletteController, type PaletteController, type PaletteTarget } from '../paletteSystem'
import type { PlanetValues } from './values'
import { createAsteroid, asteroidMetadata, reseedAsteroid, updateAsteroidTime } from './planets/asteroid'
import { createBlackHole, blackHoleMetadata, reseedBlackHole, updateBlackHoleTime } from './planets/blackHole'
import { createGalaxy, galaxyMetadata, reseedGalaxy, updateGalaxyTime } from './planets/galaxy'
import { createGasGiant1, gasGiant1Metadata, reseedGasGiant1, updateGasGiant1Time } from './planets/gasGiant1'
import { createGasGiant2, gasGiant2Metadata, reseedGasGiant2, updateGasGiant2Time } from './planets/gasGiant2'
import { createIceWorld, reseedIceWorld, updateIceWorldTime } from './planets/iceWorld'
import { createIslands, reseedIslands, updateIslandsTime } from './planets/islands'
import { createLavaWorld, reseedLavaWorld, updateLavaWorldTime } from './planets/lavaWorld'
import { createNoAtmosphere, reseedNoAtmosphere, updateNoAtmosphereTime } from './planets/noAtmosphere'
import { createStar, starMetadata, reseedStar, updateStarTime } from './planets/star'
import { createTerranDry, terranDryMetadata, reseedTerranDry, updateTerranDryTime } from './planets/terranDry'
import { createTerranWet, terranWetMetadata, reseedTerranWet, updateTerranWetTime } from './planets/terranWet'
import { PLANETS } from './values'

interface NumberUniform {
    value: number
}

interface VectorUniform {
    value: Vector2
}

export interface PlanetRuntime {
    group: Group
    pixels: NumberUniform
    rotation: NumberUniform
    lightOrigin?: VectorUniform
    metadata: PlanetValues
    reseed: (seed: number) => void
    updateTime: (time: number) => void
    setDither: (enabled: boolean) => void
    setLayerVisible: (index: number, visible: boolean) => void
    palette: PaletteController
}

interface CommonUniforms {
    pixels: NumberUniform
    rotation: NumberUniform
    seed: NumberUniform
    lightOrigin?: VectorUniform
}

const runtime = <U extends CommonUniforms>(
    metadata: PlanetValues,
    created: { group: Group, uniforms: U },
    reseed: (uniforms: U, seed: number) => void,
    updateTime: (uniforms: U, time: number) => void,
    ditherUniforms: readonly NumberUniform[],
    paletteGroups: readonly (readonly PaletteTarget[])[],
    rootSeed: number,
    onLayerVisibilityChange: (index: number, visible: boolean) => void = () => {},
): PlanetRuntime => {
    const palette = createPaletteController(metadata.name, rootSeed, paletteGroups)
    return {
        group: created.group,
        pixels: created.uniforms.pixels,
        rotation: created.uniforms.rotation,
        lightOrigin: created.uniforms.lightOrigin,
        metadata,
        reseed: (seed) => {
            reseed(created.uniforms, seed)
            if (seed % 1000 === 0) created.uniforms.seed.value = convertSeed(seed + 1)
            palette.setSeed(seed)
        },
        updateTime: (time) => { updateTime(created.uniforms, time) },
        setDither: (enabled) => {
            for (const uniform of ditherUniforms) uniform.value = enabled ? 1 : 0
        },
        setLayerVisible: (index, visible) => {
            created.group.children[index]!.visible = visible
            onLayerVisibilityChange(index, visible)
        },
        palette,
    }
}

const vectorTargets = (vectors: readonly Vector4[]): PaletteTarget[] => vectors.map((vector) => ({
    read: () => new Color(vector.x, vector.y, vector.z, vector.w),
    write: (color) => { vector.set(color.r, color.g, color.b, color.a) },
}))

const uniformTargets = (uniforms: readonly { value: Vector4 }[]): PaletteTarget[] =>
    vectorTargets(uniforms.map((entry) => entry.value))

const arrayTargets = (array: readonly unknown[]): PaletteTarget[] => vectorTargets(array as readonly Vector4[])

export const PLANET_FACTORIES = [
    { metadata: terranWetMetadata, create: (seed: number) => {
        const p = createTerranWet(seed)
        return runtime(terranWetMetadata, p, reseedTerranWet, updateTerranWetTime,
            [p.uniforms.land.shouldDither], [uniformTargets(p.uniforms.land.colors), uniformTargets(p.uniforms.clouds.colors)], seed)
    } },
    { metadata: terranDryMetadata, create: (seed: number) => {
        const p = createTerranDry(seed)
        return runtime(terranDryMetadata, p, reseedTerranDry, updateTerranDryTime,
            [p.uniforms.land.shouldDither], [arrayTargets(p.uniforms.land.colors.array)], seed)
    } },
    { metadata: PLANETS.islands, create: (seed: number) => {
        const p = createIslands(seed)
        return runtime(PLANETS.islands, p, reseedIslands, updateIslandsTime,
            [p.uniforms.water.shouldDither], [
                uniformTargets(p.uniforms.water.colors), uniformTargets(p.uniforms.land.colors),
                uniformTargets(p.uniforms.clouds.colors), uniformTargets(p.uniforms.atmosphere.colors),
            ], seed)
    } },
    { metadata: PLANETS.noAtmosphere, create: (seed: number) => {
        const p = createNoAtmosphere(seed)
        return runtime(PLANETS.noAtmosphere, p, reseedNoAtmosphere, updateNoAtmosphereTime,
            [p.uniforms.ground.shouldDither], [uniformTargets(p.uniforms.ground.colors), uniformTargets(p.uniforms.craters.colors)], seed)
    } },
    { metadata: gasGiant1Metadata, create: (seed: number) => {
        const p = createGasGiant1(seed)
        return runtime(gasGiant1Metadata, p, reseedGasGiant1, updateGasGiant1Time, [],
            [uniformTargets(p.uniforms.cloud.colors), uniformTargets(p.uniforms.cloud2.colors)], seed)
    } },
    { metadata: gasGiant2Metadata, create: (seed: number) => {
        const p = createGasGiant2(seed)
        return runtime(gasGiant2Metadata, p, reseedGasGiant2, updateGasGiant2Time,
            [p.uniforms.gasLayers.shouldDither], [
                uniformTargets(p.uniforms.gasLayers.colors), uniformTargets(p.uniforms.gasLayers.darkColors),
                uniformTargets(p.uniforms.ring.colors), uniformTargets(p.uniforms.ring.darkColors),
            ], seed, (index, visible) => {
                if (index === 0) p.uniforms.ring.occludesPlanet.value = visible ? 1 : 0
            })
    } },
    { metadata: PLANETS.iceWorld, create: (seed: number) => {
        const p = createIceWorld(seed)
        return runtime(PLANETS.iceWorld, p, reseedIceWorld, updateIceWorldTime,
            [p.uniforms.land.shouldDither], [uniformTargets(p.uniforms.land.colors), uniformTargets(p.uniforms.lakes.colors), uniformTargets(p.uniforms.clouds.colors)], seed)
    } },
    { metadata: PLANETS.lavaWorld, create: (seed: number) => {
        const p = createLavaWorld(seed)
        return runtime(PLANETS.lavaWorld, p, reseedLavaWorld, updateLavaWorldTime,
            [p.uniforms.land.shouldDither], [uniformTargets(p.uniforms.land.colors), uniformTargets(p.uniforms.craters.colors), uniformTargets(p.uniforms.lavaRivers.colors)], seed)
    } },
    { metadata: asteroidMetadata, create: (seed: number) => {
        const p = createAsteroid(seed)
        return runtime(asteroidMetadata, p, reseedAsteroid, updateAsteroidTime,
            [p.uniforms.asteroid.shouldDither], [uniformTargets(p.uniforms.asteroid.colors)], seed)
    } },
    { metadata: blackHoleMetadata, create: (seed: number) => {
        const p = createBlackHole(seed)
        return runtime(blackHoleMetadata, p, reseedBlackHole, updateBlackHoleTime,
            [p.uniforms.disk.shouldDither], [uniformTargets(p.uniforms.core.colors), uniformTargets(p.uniforms.disk.colors)], seed)
    } },
    { metadata: galaxyMetadata, create: (seed: number) => {
        const p = createGalaxy(seed)
        return runtime(galaxyMetadata, p, reseedGalaxy, updateGalaxyTime,
            [p.uniforms.galaxy.shouldDither], [arrayTargets(p.uniforms.galaxy.colors.array)], seed)
    } },
    { metadata: starMetadata, create: (seed: number) => {
        const p = createStar(seed)
        return runtime(starMetadata, p, reseedStar, updateStarTime, [
            p.uniforms.surface.shouldDither,
            p.uniforms.flares.shouldDither,
        ], [uniformTargets(p.uniforms.blobs.colors), uniformTargets(p.uniforms.surface.colors), uniformTargets(p.uniforms.flares.colors)], seed)
    } },
] as const

export type PlanetName = typeof PLANET_FACTORIES[number]['metadata']['name']

export const createPlanet = (name: string, seed: number): PlanetRuntime => {
    const factory = PLANET_FACTORIES.find((candidate) => candidate.metadata.name === name)
    if (!factory) throw new Error(`unknown celestial body: ${name}`)
    const planet = factory.create(seed)
    planet.reseed(seed)
    return planet
}
