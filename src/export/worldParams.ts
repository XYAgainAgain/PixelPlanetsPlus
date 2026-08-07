import { PLANETS, type PlanetTypeId } from '../tsl/values'
import { createPlanet } from '../tsl/registry'
import type { BackdropV1, SceneRecipeV1 } from './types'

export const WORLD_TYPE_SLUGS = {
    terranWet: 'wet',
    terranDry: 'dry',
    islands: 'islands',
    noAtmosphere: 'barren',
    gasGiant1: 'gas',
    gasGiant2: 'ringed',
    iceWorld: 'ice',
    lavaWorld: 'lava',
    asteroid: 'asteroid',
    blackHole: 'black-hole',
    galaxy: 'galaxy',
    star: 'star',
} as const satisfies Record<PlanetTypeId, string>

const DEFAULT_TYPE: PlanetTypeId = 'islands'
const DEFAULT_SEED = 1
const DEFAULT_PIXELS = 100
const DEFAULT_ROTATION = 0
const DEFAULT_DITHER = true
const DEFAULT_BACKDROP_KIND = 'stars' as const

const slugTypes = new Map<string, PlanetTypeId>(Object.entries(WORLD_TYPE_SLUGS)
    .map(([type, slug]) => [slug, type as PlanetTypeId]))

const paletteDefaults = new Map<PlanetTypeId, SceneRecipeV1['palette']>()

export const defaultPaletteFor = (celestialType: PlanetTypeId): SceneRecipeV1['palette'] => {
    const cached = paletteDefaults.get(celestialType)
    if (cached) return cached.map(group => [...group])
    const planet = createPlanet(PLANETS[celestialType].name, DEFAULT_SEED)
    const palette = [planet.palette.colors().map(color => color.toHex())]
    paletteDefaults.set(celestialType, palette)
    return palette.map(group => [...group])
}

const defaultLayers = (celestialType: PlanetTypeId): SceneRecipeV1['layers'] =>
    PLANETS[celestialType].layers.map(layer => ({ id: layer.node, visible: true }))

const samePalette = (left: SceneRecipeV1['palette'], right: SceneRecipeV1['palette']): boolean =>
    left.length === right.length && left.every((group, groupIndex) => group.length === right[groupIndex]?.length
        && group.every((color, colorIndex) => color.toLowerCase() === right[groupIndex]?.[colorIndex]?.toLowerCase()))

const compactNumber = (value: number): string => {
    const text = String(value)
    return text.replace(/^(-?)0\./, '$1.')
}

const validInteger = (value: string | null, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number | null => {
    if (value === null || !/^-?\d+$/.test(value)) return null
    const number = Number(value)
    return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : null
}

const validNumber = (value: string | null): number | null => {
    if (value === null || value.trim() === '') return null
    const number = Number(value)
    return Number.isFinite(number) ? number : null
}

const backdropFor = (kind: BackdropV1['kind'], seed: number, color?: string): BackdropV1 => {
    if (kind === 'transparent') return { kind }
    if (kind === 'solid') return { kind, color: color ?? '#000000' }
    return { kind, seed, density: 1, brightness: 1, starScale: 1, specialStarMix: 0.5, gradientPhase: 0 }
}

const backdropSlug = (backdrop: BackdropV1): string => {
    if (backdrop.kind === 'transparent') return 'n'
    if (backdrop.kind === 'gradient') return 'g'
    if (backdrop.kind === 'stars-gradient') return 'sg'
    if (backdrop.kind === 'solid') return `c${backdrop.color.replace(/^#/, '').toLowerCase()}`
    return 's'
}

const decodeBackdrop = (value: string | null, seed: number): BackdropV1 => {
    if (value === 'n') return backdropFor('transparent', seed)
    if (value === 'g') return backdropFor('gradient', seed)
    if (value === 'sg') return backdropFor('stars-gradient', seed)
    if (value?.match(/^c[0-9a-f]{6}$/i)) return backdropFor('solid', seed, `#${value.slice(1).toLowerCase()}`)
    return backdropFor(DEFAULT_BACKDROP_KIND, seed)
}

const paletteValue = (palette: SceneRecipeV1['palette']): string | null => {
    const colors = palette.flat()
    if (!colors.every(color => /^#[0-9a-f]{6}$/i.test(color))) return null
    const bytes = new Uint8Array(colors.length * 3)
    colors.forEach((color, index) => {
        const value = Number.parseInt(color.slice(1), 16)
        bytes[index * 3] = value >> 16
        bytes[index * 3 + 1] = value >> 8
        bytes[index * 3 + 2] = value
    })
    return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

const decodePalette = (value: string | null): SceneRecipeV1['palette'] | null => {
    if (value === null || !/^[A-Za-z0-9_-]*$/.test(value)) return null
    try {
        const encoded = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
        const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0))
        if (bytes.length === 0 || bytes.length % 3 !== 0) return null
        return [Array.from({ length: bytes.length / 3 }, (_, index) =>
            `#${bytes[index * 3]!.toString(16).padStart(2, '0')}${bytes[index * 3 + 1]!.toString(16).padStart(2, '0')}${bytes[index * 3 + 2]!.toString(16).padStart(2, '0')}`)]
    } catch {
        return null
    }
}

const hiddenLayerMask = (layers: SceneRecipeV1['layers'], celestialType: PlanetTypeId): number => {
    const visibility = new Map(layers.map(layer => [layer.id, layer.visible]))
    return defaultLayers(celestialType).reduce((mask, layer, index) =>
        visibility.get(layer.id) === false ? mask | 2 ** index : mask, 0)
}

// Built-in palettes are omitted, so their size never consumes the compact world-link budget.
export const encodeWorldParams = (recipe: SceneRecipeV1): URLSearchParams => {
    const params = new URLSearchParams()
    const celestialType = recipe.celestialType in WORLD_TYPE_SLUGS ? recipe.celestialType : DEFAULT_TYPE
    if (celestialType !== DEFAULT_TYPE) params.set('t', WORLD_TYPE_SLUGS[celestialType])
    if (recipe.seed !== DEFAULT_SEED) params.set('s', compactNumber(recipe.seed))
    if (recipe.pixels !== DEFAULT_PIXELS) params.set('p', compactNumber(recipe.pixels))
    if (recipe.body.phase !== DEFAULT_ROTATION) params.set('r', compactNumber(recipe.body.phase))
    if (recipe.body.rotation !== DEFAULT_ROTATION) params.set('ti', compactNumber(recipe.body.rotation))
    if (recipe.dither !== DEFAULT_DITHER) params.set('d', recipe.dither ? '1' : '0')
    const layers = hiddenLayerMask(recipe.layers, celestialType)
    if (layers !== 0) params.set('l', layers.toString(36))
    const backdrop = backdropSlug(recipe.backdrop)
    if (backdrop !== 's') params.set('bg', backdrop)
    if ('seed' in recipe.backdrop && recipe.backdrop.seed !== recipe.seed) params.set('bs', compactNumber(recipe.backdrop.seed))
    const defaults = defaultPaletteFor(celestialType)
    if (!samePalette(recipe.palette, defaults)) {
        const palette = paletteValue(recipe.palette)
        if (palette !== null) params.set('pal', palette)
    }
    return params
}

export const decodeWorldParams = (params: URLSearchParams): Partial<SceneRecipeV1> => {
    const celestialType = slugTypes.get(params.get('t') ?? '') ?? DEFAULT_TYPE
    const seed = validInteger(params.get('s'), 0) ?? DEFAULT_SEED
    const pixels = validInteger(params.get('p'), 1, 2048) ?? DEFAULT_PIXELS
    const phase = validNumber(params.get('r')) ?? DEFAULT_ROTATION
    const rotation = validNumber(params.get('ti')) ?? DEFAULT_ROTATION
    const dither = params.get('d') === '0' ? false : DEFAULT_DITHER
    const layerMask = validInteger(params.get('l'), 0) ?? 0
    const layers = defaultLayers(celestialType).map((layer, index) => ({ ...layer, visible: (layerMask & 2 ** index) === 0 }))
    const backgroundSeed = validInteger(params.get('bs'), 0) ?? seed
    const defaults = defaultPaletteFor(celestialType)
    const decodedPalette = decodePalette(params.get('pal'))
    const palette = decodedPalette
        ? defaults.map((group, groupIndex) => group.map((color, colorIndex) =>
            decodedPalette[groupIndex]?.[colorIndex] ?? color))
        : defaults
    return {
        celestialType,
        seed,
        pixels,
        palette,
        layers,
        dither,
        backdrop: decodeBackdrop(params.get('bg'), backgroundSeed),
        body: { phase, rotation } as SceneRecipeV1['body'],
    }
}

export const worldParamsLength = (recipe: SceneRecipeV1): number => encodeWorldParams(recipe).toString().length
