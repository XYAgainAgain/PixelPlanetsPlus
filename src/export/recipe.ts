import { PLANETS, type PlanetTypeId } from '../tsl/values'
import { deflateSync, inflateSync } from 'fflate'
import { canonicalFrameSize, nearestExportScale } from './layout'
import type { BackdropBaseV2, BackdropStarsV2, BackdropV2, ExportEffectV1, ExportScale, PlaybackDirection, SceneRecipeV2, Vec2 } from './types'
import { defaultPaletteFor } from './worldParams'

export const SCENE_SCHEMA = 'pixelplanetsplus-scene@2' as const
const LEGACY_SCENE_SCHEMA = 'pixelplanetsplus-scene@1'
export const MAX_EXPORT_DIMENSION = 32_768
export const MAX_EXPORT_PIXELS = 268_435_456
// The GIF and spritesheet controls offer 1–100 frames per second; anything outside has no finite duration.
export const MIN_FRAMES_PER_SECOND = 1
export const MAX_FRAMES_PER_SECOND = 100
// Schema maxima sit well above anything the app writes, and bound what a hostile link can make us allocate.
export const SCENE_LIMITS = {
    payloadCharacters: 8192,
    packedBytes: 16_384,
    paletteGroups: 8,
    paletteColors: 64,
    layers: 32,
    effects: 16,
    effectParameters: 32,
    textBytes: 128,
    frameCount: 4096,
    columns: 4096,
    margin: 4096,
} as const

export class SceneRecipeError extends Error {
    constructor(message: string, readonly path = '') {
        super(path ? `${path}: ${message}` : message)
        this.name = 'SceneRecipeError'
    }
}

const object = (value: unknown, path: string): Record<string, unknown> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new SceneRecipeError('expected an object', path)
    }
    return value as Record<string, unknown>
}

const text = (value: unknown, path: string): string => {
    if (typeof value !== 'string') throw new SceneRecipeError('expected a string', path)
    if (new TextEncoder().encode(value).length > SCENE_LIMITS.textBytes) {
        throw new SceneRecipeError(`expected at most ${SCENE_LIMITS.textBytes} bytes`, path)
    }
    return value
}

const list = (value: unknown, path: string, maximum: number): unknown[] => {
    if (!Array.isArray(value)) throw new SceneRecipeError('expected an array', path)
    if (value.length > maximum) throw new SceneRecipeError(`expected at most ${maximum} entries`, path)
    return value
}

const finite = (value: unknown, path: string): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new SceneRecipeError('expected a finite number', path)
    return value
}

const integer = (value: unknown, path: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number => {
    const result = finite(value, path)
    if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
        throw new SceneRecipeError(`expected an integer from ${minimum} to ${maximum}`, path)
    }
    return result
}

const boolean = (value: unknown, path: string): boolean => {
    if (typeof value !== 'boolean') throw new SceneRecipeError('expected a boolean', path)
    return value
}

const tuple = (value: unknown, path: string): Vec2 => {
    if (!Array.isArray(value) || value.length !== 2) throw new SceneRecipeError('expected a two-number tuple', path)
    return [finite(value[0], `${path}[0]`), finite(value[1], `${path}[1]`)]
}

const oneOf = <T extends string>(value: unknown, choices: readonly T[], path: string): T => {
    if (typeof value !== 'string' || !choices.includes(value as T)) {
        throw new SceneRecipeError(`expected one of ${choices.join(', ')}`, path)
    }
    return value as T
}

const hexColor = (value: unknown, path: string): string => {
    const color = text(value, path)
    if (!/^#[0-9a-f]{6}$/i.test(color)) throw new SceneRecipeError('expected a six-digit hex color', path)
    return color.toLowerCase()
}

const validateStars = (value: unknown, path: string): BackdropStarsV2 => {
    const source = object(value, path)
    return {
        seed: integer(source.seed, `${path}.seed`, 0),
        density: finite(source.density, `${path}.density`),
        brightness: finite(source.brightness, `${path}.brightness`),
        starScale: finite(source.starScale, `${path}.starScale`),
        specialStarMix: finite(source.specialStarMix, `${path}.specialStarMix`),
    }
}

const validateBackdrop = (value: unknown): BackdropV2 => {
    const source = object(value, 'backdrop')
    const baseSource = object(source.base, 'backdrop.base')
    const kind = oneOf(baseSource.kind, ['transparent', 'solid', 'gradient'] as const, 'backdrop.base.kind')
    const base: BackdropBaseV2 = kind === 'transparent' ? { kind }
        : kind === 'solid' ? { kind, color: hexColor(baseSource.color, 'backdrop.base.color') }
            : { kind, phase: finite(baseSource.phase, 'backdrop.base.phase') }
    return { base, stars: source.stars === null ? null : validateStars(source.stars, 'backdrop.stars') }
}

// Scene@1 named five fixed combinations; each maps onto a base plus an optional star layer.
const migrateLegacyBackdrop = (value: unknown): BackdropV2 => {
    const source = object(value, 'backdrop')
    const kind = oneOf(source.kind, ['transparent', 'solid', 'stars', 'gradient', 'stars-gradient'] as const, 'backdrop.kind')
    if (kind === 'transparent') return { base: { kind }, stars: null }
    if (kind === 'solid') return { base: { kind, color: hexColor(source.color, 'backdrop.color') }, stars: null }
    const stars = kind === 'gradient' ? null : validateStars(source, 'backdrop')
    const base: BackdropBaseV2 = kind === 'stars' ? { kind: 'transparent' }
        : { kind: 'gradient', phase: finite(source.gradientPhase, 'backdrop.gradientPhase') }
    return { base, stars }
}

const validateEffects = (value: unknown): ExportEffectV1[] => {
    return list(value, 'effects', SCENE_LIMITS.effects).map((entry, index) => {
        const path = `effects[${index}]`
        const source = object(entry, path)
        const rawParameters = object(source.parameters, `${path}.parameters`)
        if (Object.keys(rawParameters).length > SCENE_LIMITS.effectParameters) {
            throw new SceneRecipeError(`expected at most ${SCENE_LIMITS.effectParameters} parameters`, `${path}.parameters`)
        }
        const parameters: Record<string, boolean | number | string> = {}
        for (const [key, parameter] of Object.entries(rawParameters)) {
            text(key, `${path}.parameters`)
            if (typeof parameter === 'string') text(parameter, `${path}.parameters.${key}`)
            if (typeof parameter !== 'boolean' && typeof parameter !== 'string'
                && (typeof parameter !== 'number' || !Number.isFinite(parameter))) {
                throw new SceneRecipeError('expected a boolean, finite number, or string', `${path}.parameters.${key}`)
            }
            parameters[key] = parameter
        }
        return {
            id: text(source.id, `${path}.id`),
            version: integer(source.version, `${path}.version`, 1),
            enabled: boolean(source.enabled, `${path}.enabled`),
            parameters,
        }
    })
}

// The bound is checked at wire precision too, so a value that would quantize below it never validates.
const framesPerSecond = (value: unknown): number => {
    const result = finite(value, 'export.framesPerSecond')
    const quantized = Math.round(result * 10_000) / 10_000
    if (result < MIN_FRAMES_PER_SECOND || quantized < MIN_FRAMES_PER_SECOND || result > MAX_FRAMES_PER_SECOND) {
        throw new SceneRecipeError(`expected ${MIN_FRAMES_PER_SECOND} to ${MAX_FRAMES_PER_SECOND} frames per second`, 'export.framesPerSecond')
    }
    return result
}

/* Accepts scene@2 as-is and migrates scene@1 (body.size and the named backdrops) to its nearest equivalent. */
export const validateSceneRecipe = (value: unknown): SceneRecipeV2 => {
    const source = object(value, 'scene')
    const legacy = source.schema === LEGACY_SCENE_SCHEMA
    if (!legacy && source.schema !== SCENE_SCHEMA) throw new SceneRecipeError(`unsupported schema ${String(source.schema)}`, 'schema')
    const celestialType = oneOf(source.celestialType, Object.keys(PLANETS) as PlanetTypeId[], 'celestialType')
    const canvas = object(source.canvas, 'canvas')
    const width = integer(canvas.width, 'canvas.width', 1, MAX_EXPORT_DIMENSION)
    const height = integer(canvas.height, 'canvas.height', 1, MAX_EXPORT_DIMENSION)
    if (width * height > MAX_EXPORT_PIXELS) throw new SceneRecipeError(`canvas exceeds ${MAX_EXPORT_PIXELS} pixels`, 'canvas')
    const body = object(source.body, 'body')
    const seed = integer(source.seed, 'seed', 0)
    const pixels = integer(source.pixels, 'pixels', 1, MAX_EXPORT_DIMENSION)
    const palette = list(source.palette, 'palette', SCENE_LIMITS.paletteGroups).map((group, groupIndex) =>
        list(group, `palette[${groupIndex}]`, SCENE_LIMITS.paletteColors)
            .map((color, colorIndex) => hexColor(color, `palette[${groupIndex}][${colorIndex}]`)))
    const layerIds = new Set<string>()
    const layers = list(source.layers, 'layers', SCENE_LIMITS.layers).map((entry, index) => {
        const layer = object(entry, `layers[${index}]`)
        const id = text(layer.id, `layers[${index}].id`)
        if (layerIds.has(id)) throw new SceneRecipeError('duplicate layer identifier', `layers[${index}].id`)
        layerIds.add(id)
        return { id, visible: boolean(layer.visible, `layers[${index}].visible`) }
    })
    const exportSource = object(source.export, 'export')
    let scale = integer(exportSource.scale, 'export.scale', 1, 8)
    if (![1, 2, 4, 8].includes(scale)) throw new SceneRecipeError('expected one of 1, 2, 4, 8', 'export.scale')
    if (legacy) {
        // Scene@1 sized the body against the canvas's shorter edge; keep that on-canvas size as the nearest zoom.
        const bodySize = finite(body.size, 'body.size')
        if (bodySize <= 0) throw new SceneRecipeError('expected a positive number', 'body.size')
        scale = nearestExportScale(bodySize * Math.min(width, height), canonicalFrameSize(celestialType, pixels))
    }
    return {
        schema: SCENE_SCHEMA,
        celestialType,
        canvas: { width, height },
        body: {
            center: tuple(body.center, 'body.center'),
            phase: finite(body.phase, 'body.phase'),
            rotation: finite(body.rotation, 'body.rotation'),
            light: body.light === null ? null : tuple(body.light, 'body.light'),
        },
        seed,
        pixels,
        palette,
        layers,
        dither: boolean(source.dither, 'dither'),
        backdrop: legacy ? migrateLegacyBackdrop(source.backdrop) : validateBackdrop(source.backdrop),
        export: {
            scale: scale as ExportScale,
            frameCount: integer(exportSource.frameCount, 'export.frameCount', 1, SCENE_LIMITS.frameCount),
            columns: integer(exportSource.columns, 'export.columns', 1, SCENE_LIMITS.columns),
            margin: integer(exportSource.margin, 'export.margin', 0, SCENE_LIMITS.margin),
            startPhase: finite(exportSource.startPhase, 'export.startPhase'),
            endPhase: finite(exportSource.endPhase, 'export.endPhase'),
            direction: oneOf(exportSource.direction, ['forward', 'reverse', 'ping-pong'] as const, 'export.direction') as PlaybackDirection,
            framesPerSecond: framesPerSecond(exportSource.framesPerSecond),
        },
        effects: validateEffects(source.effects),
    }
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const WIRE_VERSION = 2
const LEGACY_WIRE_VERSION = 1
const DEFLATED = 0x80
const GROUP_PALETTE = 1 << 0
const GROUP_LAYERS = 1 << 1
const GROUP_BACKDROP = 1 << 2
const GROUP_EXPORT = 1 << 3
const GROUP_EFFECTS = 1 << 4
const FIXED_SCALE = 10_000
const PLANET_IDS = Object.keys(PLANETS) as PlanetTypeId[]
const DIRECTIONS = ['forward', 'reverse', 'ping-pong'] as const
const LEGACY_BACKDROPS = ['transparent', 'solid', 'stars', 'gradient', 'stars-gradient'] as const
const BACKDROP_BASES = ['transparent', 'solid', 'gradient'] as const
const BACKDROP_STARS = 4
const DEFAULT_EXPORT: SceneRecipeV2['export'] = {
    scale: 1, frameCount: 60, columns: 8, margin: 0,
    startPhase: 0, endPhase: 1, direction: 'forward', framesPerSecond: 12,
}

class Writer {
    readonly bytes: number[] = []

    byte(value: number): void { this.bytes.push(value & 0xff) }
    varint(value: number): void {
        let remaining = value
        while (remaining >= 0x80) {
            this.byte((remaining % 0x80) | 0x80)
            remaining = Math.floor(remaining / 0x80)
        }
        this.byte(remaining)
    }
    signed(value: number): void { this.varint(value < 0 ? -value * 2 - 1 : value * 2) }
    fixed(value: number): void { this.signed(Math.round(value * FIXED_SCALE)) }
    text(value: string): void {
        const encoded = new TextEncoder().encode(value)
        this.varint(encoded.length)
        this.bytes.push(...encoded)
    }
    color(value: string): void {
        const rgb = Number.parseInt(value.slice(1), 16)
        this.byte(rgb >> 16)
        this.byte(rgb >> 8)
        this.byte(rgb)
    }
    finish(): Uint8Array { return Uint8Array.from(this.bytes) }
}

class Reader {
    private offset = 0

    constructor(private readonly bytes: Uint8Array) {}
    byte(): number {
        const value = this.bytes[this.offset]
        if (value === undefined) throw new SceneRecipeError('truncated binary payload')
        this.offset += 1
        return value
    }
    varint(): number {
        let result = 0
        let multiplier = 1
        for (let count = 0; count < 8; count += 1) {
            const value = this.byte()
            result += (value & 0x7f) * multiplier
            if ((value & 0x80) === 0) {
                if (!Number.isSafeInteger(result)) throw new SceneRecipeError('integer exceeds wire range')
                return result
            }
            multiplier *= 0x80
        }
        throw new SceneRecipeError('invalid varint')
    }
    signed(): number {
        const value = this.varint()
        return value % 2 === 0 ? value / 2 : -(value + 1) / 2
    }
    fixed(): number { return this.signed() / FIXED_SCALE }
    // Rejects a count before anything is allocated for it: over the schema maximum, or more items than bytes left.
    count(maximum: number, minimumBytesEach: number, what: string): number {
        const value = this.varint()
        if (value > maximum || value * minimumBytesEach > this.bytes.length - this.offset) {
            throw new SceneRecipeError(`too many ${what}`)
        }
        return value
    }
    text(): string {
        const length = this.varint()
        if (length > SCENE_LIMITS.textBytes) throw new SceneRecipeError('binary string too long')
        const end = this.offset + length
        if (end > this.bytes.length) throw new SceneRecipeError('truncated binary string')
        const value = new TextDecoder('utf-8', { fatal: true }).decode(this.bytes.subarray(this.offset, end))
        this.offset = end
        return value
    }
    color(): string {
        return `#${this.byte().toString(16).padStart(2, '0')}${this.byte().toString(16).padStart(2, '0')}${this.byte().toString(16).padStart(2, '0')}`
    }
    done(): boolean { return this.offset === this.bytes.length }
}

const sameExport = (value: SceneRecipeV2['export']): boolean =>
    Object.entries(DEFAULT_EXPORT).every(([key, expected]) => value[key as keyof SceneRecipeV2['export']] === expected)

const defaultLayers = (celestialType: PlanetTypeId): SceneRecipeV2['layers'] =>
    PLANETS[celestialType].layers.map(layer => ({ id: layer.node, visible: true }))

const sameLayers = (left: SceneRecipeV2['layers'], right: SceneRecipeV2['layers']): boolean =>
    left.length === right.length && left.every((layer, index) => layer.id === right[index]?.id && layer.visible === right[index]?.visible)

const samePalette = (left: SceneRecipeV2['palette'], right: SceneRecipeV2['palette']): boolean =>
    left.length === right.length && left.every((group, groupIndex) => group.length === right[groupIndex]?.length
        && group.every((color, colorIndex) => color === right[groupIndex]?.[colorIndex]))

const wireNumber = (value: number): number => {
    const fixed = Math.round(value * FIXED_SCALE)
    if (!Number.isSafeInteger(fixed) || Math.abs(fixed) > Math.floor(Number.MAX_SAFE_INTEGER / 2)) {
        throw new SceneRecipeError('number exceeds wire range')
    }
    return fixed / FIXED_SCALE
}

const quantizeForWire = (recipe: SceneRecipeV2): SceneRecipeV2 => ({
    ...recipe,
    body: {
        ...recipe.body,
        center: [wireNumber(recipe.body.center[0]), wireNumber(recipe.body.center[1])],
        phase: wireNumber(recipe.body.phase),
        rotation: wireNumber(recipe.body.rotation),
        light: recipe.body.light
            ? [wireNumber(recipe.body.light[0]), wireNumber(recipe.body.light[1])]
            : null,
    },
    backdrop: {
        base: recipe.backdrop.base.kind === 'gradient'
            ? { kind: 'gradient', phase: wireNumber(recipe.backdrop.base.phase) }
            : recipe.backdrop.base,
        stars: recipe.backdrop.stars && {
            ...recipe.backdrop.stars,
            density: wireNumber(recipe.backdrop.stars.density),
            brightness: wireNumber(recipe.backdrop.stars.brightness),
            starScale: wireNumber(recipe.backdrop.stars.starScale),
            specialStarMix: wireNumber(recipe.backdrop.stars.specialStarMix),
        },
    },
    export: {
        ...recipe.export,
        startPhase: wireNumber(recipe.export.startPhase),
        endPhase: wireNumber(recipe.export.endPhase),
        framesPerSecond: wireNumber(recipe.export.framesPerSecond),
    },
    effects: recipe.effects.map(effect => ({
        ...effect,
        parameters: Object.fromEntries(Object.entries(effect.parameters)
            .map(([key, value]) => [key, typeof value === 'number' ? wireNumber(value) : value])),
    })),
})

const writeBackdrop = (writer: Writer, backdrop: BackdropV2): void => {
    const { base, stars } = backdrop
    writer.byte(BACKDROP_BASES.indexOf(base.kind) | (stars ? BACKDROP_STARS : 0))
    if (base.kind === 'solid') writer.color(base.color)
    if (base.kind === 'gradient') writer.fixed(base.phase)
    if (stars) {
        writer.varint(stars.seed)
        writer.fixed(stars.density)
        writer.fixed(stars.brightness)
        writer.fixed(stars.starScale)
        writer.fixed(stars.specialStarMix)
    }
}

const readBackdrop = (reader: Reader): BackdropV2 => {
    const flags = reader.byte()
    const kind = BACKDROP_BASES[flags & 3]
    if (!kind || (flags & ~(3 | BACKDROP_STARS)) !== 0) throw new SceneRecipeError('unknown backdrop encoding')
    const base: BackdropBaseV2 = kind === 'transparent' ? { kind }
        : kind === 'solid' ? { kind, color: reader.color() }
            : { kind, phase: reader.fixed() }
    const stars = flags & BACKDROP_STARS ? {
        seed: reader.varint(), density: reader.fixed(), brightness: reader.fixed(),
        starScale: reader.fixed(), specialStarMix: reader.fixed(),
    } : null
    return { base, stars }
}

const readLegacyBackdrop = (reader: Reader): unknown => {
    const kind = LEGACY_BACKDROPS[reader.byte()]
    if (!kind) throw new SceneRecipeError('unknown backdrop kind')
    if (kind === 'transparent') return { kind }
    if (kind === 'solid') return { kind, color: reader.color() }
    return {
        kind, seed: reader.varint(), density: reader.fixed(), brightness: reader.fixed(),
        starScale: reader.fixed(), specialStarMix: reader.fixed(), gradientPhase: reader.fixed(),
    }
}

const writeEffects = (writer: Writer, effects: readonly ExportEffectV1[]): void => {
    writer.varint(effects.length)
    for (const effect of effects) {
        writer.text(effect.id)
        writer.varint(effect.version)
        writer.byte(effect.enabled ? 1 : 0)
        const parameters = Object.entries(effect.parameters)
        writer.varint(parameters.length)
        for (const [key, value] of parameters) {
            writer.text(key)
            if (typeof value === 'boolean') {
                writer.byte(value ? 1 : 0)
            } else if (typeof value === 'number') {
                writer.byte(2)
                writer.fixed(value)
            } else {
                writer.byte(3)
                writer.text(value)
            }
        }
    }
}

const readEffects = (reader: Reader): ExportEffectV1[] => Array.from({ length: reader.count(SCENE_LIMITS.effects, 4, 'effects') }, () => {
    const id = reader.text()
    const version = reader.varint()
    const enabled = reader.byte() !== 0
    const parameters: Record<string, boolean | number | string> = {}
    const parameterCount = reader.count(SCENE_LIMITS.effectParameters, 2, 'effect parameters')
    for (let index = 0; index < parameterCount; index += 1) {
        const key = reader.text()
        const type = reader.byte()
        if (type === 0 || type === 1) parameters[key] = type === 1
        else if (type === 2) parameters[key] = reader.fixed()
        else if (type === 3) parameters[key] = reader.text()
        else throw new SceneRecipeError('unknown effect parameter type')
    }
    return { id, version, enabled, parameters }
})

const packRecipe = (recipe: SceneRecipeV2): Uint8Array => {
    const writer = new Writer()
    const defaults = defaultLayers(recipe.celestialType)
    const paletteDefaults = defaultPaletteFor(recipe.celestialType)
    const groups = (!samePalette(recipe.palette, paletteDefaults) ? GROUP_PALETTE : 0)
        | (!sameLayers(recipe.layers, defaults) ? GROUP_LAYERS : 0)
        | (recipe.backdrop.base.kind !== 'transparent' || recipe.backdrop.stars ? GROUP_BACKDROP : 0)
        | (!sameExport(recipe.export) ? GROUP_EXPORT : 0)
        | (recipe.effects.length > 0 ? GROUP_EFFECTS : 0)
    writer.byte(groups)
    writer.byte((recipe.dither ? 1 : 0) | (recipe.body.light ? 2 : 0))
    writer.byte(PLANET_IDS.indexOf(recipe.celestialType))
    writer.varint(recipe.canvas.width)
    writer.varint(recipe.canvas.height)
    writer.varint(recipe.seed)
    writer.varint(recipe.pixels)
    // Scene geometry and animation values use signed fixed-point with four decimal places.
    writer.fixed(recipe.body.center[0])
    writer.fixed(recipe.body.center[1])
    writer.fixed(recipe.body.phase)
    writer.fixed(recipe.body.rotation)
    if (recipe.body.light) {
        writer.fixed(recipe.body.light[0])
        writer.fixed(recipe.body.light[1])
    }
    if (groups & GROUP_PALETTE) {
        writer.varint(recipe.palette.length)
        for (const group of recipe.palette) {
            writer.varint(group.length)
            for (const color of group) writer.color(color)
        }
    }
    if (groups & GROUP_LAYERS) {
        const stableIds = recipe.layers.length === defaults.length
            && recipe.layers.every((layer, index) => layer.id === defaults[index]?.id)
        writer.byte(stableIds ? 0 : 1)
        if (stableIds) {
            for (let start = 0; start < recipe.layers.length; start += 8) {
                let visibility = 0
                for (let bit = 0; bit < 8 && start + bit < recipe.layers.length; bit += 1) {
                    if (recipe.layers[start + bit]!.visible) visibility |= 1 << bit
                }
                writer.byte(visibility)
            }
        } else {
            writer.varint(recipe.layers.length)
            for (const layer of recipe.layers) {
                writer.text(layer.id)
                writer.byte(layer.visible ? 1 : 0)
            }
        }
    }
    if (groups & GROUP_BACKDROP) writeBackdrop(writer, recipe.backdrop)
    if (groups & GROUP_EXPORT) {
        writer.byte(Math.log2(recipe.export.scale))
        writer.varint(recipe.export.frameCount)
        writer.varint(recipe.export.columns)
        writer.varint(recipe.export.margin)
        writer.fixed(recipe.export.startPhase)
        writer.fixed(recipe.export.endPhase)
        writer.byte(DIRECTIONS.indexOf(recipe.export.direction))
        writer.fixed(recipe.export.framesPerSecond)
    }
    if (groups & GROUP_EFFECTS) writeEffects(writer, recipe.effects)
    return writer.finish()
}

// Wire 1 carried body.size and the named scene@1 backdrops; validation migrates both.
const unpackRecipe = (bytes: Uint8Array, version: number): SceneRecipeV2 => {
    const legacy = version === LEGACY_WIRE_VERSION
    const reader = new Reader(bytes)
    const groups = reader.byte()
    if (groups & ~0x1f) throw new SceneRecipeError('unknown optional group')
    const flags = reader.byte()
    if (flags & ~3) throw new SceneRecipeError('unknown boolean flag')
    const celestialType = PLANET_IDS[reader.byte()]
    if (!celestialType) throw new SceneRecipeError('unknown celestial type')
    const canvas = { width: reader.varint(), height: reader.varint() }
    const seed = reader.varint()
    const pixels = reader.varint()
    const center: Vec2 = [reader.fixed(), reader.fixed()]
    const size = legacy ? reader.fixed() : undefined
    const phase = reader.fixed()
    const rotation = reader.fixed()
    const light: Vec2 | null = flags & 2 ? [reader.fixed(), reader.fixed()] : null
    let palette = defaultPaletteFor(celestialType)
    if (groups & GROUP_PALETTE) {
        palette = Array.from({ length: reader.count(SCENE_LIMITS.paletteGroups, 1, 'palette groups') }, () =>
            Array.from({ length: reader.count(SCENE_LIMITS.paletteColors, 3, 'palette colors') }, () => reader.color()))
    }
    let layers = defaultLayers(celestialType)
    if (groups & GROUP_LAYERS) {
        const mode = reader.byte()
        if (mode === 0) {
            const visibility = Array.from({ length: Math.ceil(layers.length / 8) }, () => reader.byte())
            layers = layers.map((layer, index) => ({
                ...layer,
                visible: (visibility[Math.floor(index / 8)]! & (1 << (index % 8))) !== 0,
            }))
        } else if (mode === 1) {
            layers = Array.from({ length: reader.count(SCENE_LIMITS.layers, 2, 'layers') }, () => ({ id: reader.text(), visible: reader.byte() !== 0 }))
        } else throw new SceneRecipeError('unknown layer encoding')
    }
    const transparent = legacy ? { kind: 'transparent' } : { base: { kind: 'transparent' }, stars: null }
    const backdrop = groups & GROUP_BACKDROP ? (legacy ? readLegacyBackdrop(reader) : readBackdrop(reader)) : transparent
    let exportSettings = { ...DEFAULT_EXPORT }
    if (groups & GROUP_EXPORT) {
        const scale = 2 ** reader.byte()
        exportSettings = {
            scale: scale as ExportScale,
            frameCount: reader.varint(), columns: reader.varint(), margin: reader.varint(),
            startPhase: reader.fixed(), endPhase: reader.fixed(),
            direction: DIRECTIONS[reader.byte()] as PlaybackDirection,
            framesPerSecond: reader.fixed(),
        }
    }
    const effects = groups & GROUP_EFFECTS ? readEffects(reader) : []
    if (!reader.done()) throw new SceneRecipeError('trailing binary data')
    return validateSceneRecipe({
        schema: legacy ? LEGACY_SCENE_SCHEMA : SCENE_SCHEMA, celestialType, canvas,
        body: { center, size, phase, rotation, light }, seed, pixels, palette, layers,
        dither: (flags & 1) !== 0, backdrop, export: exportSettings, effects,
    })
}

const encodeBase64 = (bytes: Uint8Array): string => {
    let result = ''
    for (let index = 0; index < bytes.length; index += 3) {
        const a = bytes[index]!
        const hasB = index + 1 < bytes.length
        const hasC = index + 2 < bytes.length
        const b = hasB ? bytes[index + 1]! : 0
        const c = hasC ? bytes[index + 2]! : 0
        result += BASE64[a >> 2]
        result += BASE64[((a & 3) << 4) | (b >> 4)]
        result += hasB ? BASE64[((b & 15) << 2) | (c >> 6)] : '='
        result += hasC ? BASE64[c & 63] : '='
    }
    return result
}

const decodeBase64 = (value: string): Uint8Array => {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) throw new SceneRecipeError('invalid base64url payload')
    const outputLength = value.length / 4 * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0)
    const output = new Uint8Array(outputLength)
    let outputIndex = 0
    for (let index = 0; index < value.length; index += 4) {
        const a = BASE64.indexOf(value[index]!)
        const b = BASE64.indexOf(value[index + 1]!)
        const c = value[index + 2] === '=' ? 0 : BASE64.indexOf(value[index + 2]!)
        const d = value[index + 3] === '=' ? 0 : BASE64.indexOf(value[index + 3]!)
        if (a < 0 || b < 0 || c < 0 || d < 0) throw new SceneRecipeError('invalid base64url payload')
        if (outputIndex < outputLength) output[outputIndex++] = (a << 2) | (b >> 4)
        if (outputIndex < outputLength) output[outputIndex++] = ((b & 15) << 4) | (c >> 2)
        if (outputIndex < outputLength) output[outputIndex++] = ((c & 3) << 6) | d
    }
    return output
}

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
    left.length === right.length && left.every((value, index) => value === right[index])

export const encodeSceneRecipe = (recipe: SceneRecipeV2): string => {
    const packed = packRecipe(validateSceneRecipe(quantizeForWire(recipe)))
    const deflated = deflateSync(packed, { level: 9 })
    const compressed = deflated.length < packed.length
    const bytes = new Uint8Array(1 + (compressed ? deflated.length : packed.length))
    bytes[0] = WIRE_VERSION | (compressed ? DEFLATED : 0)
    bytes.set(compressed ? deflated : packed, 1)
    return encodeBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

// A caller-supplied buffer makes fflate drop output past its end instead of growing, so a full buffer means too big.
const inflateBounded = (body: Uint8Array): Uint8Array => {
    const inflated = inflateSync(body, { out: new Uint8Array(SCENE_LIMITS.packedBytes + 1) })
    if (inflated.length > SCENE_LIMITS.packedBytes) throw new SceneRecipeError('scene payload inflates past its limit')
    return inflated
}

export const decodeSceneRecipe = (payload: string): SceneRecipeV2 => {
    try {
        if (payload.length > SCENE_LIMITS.payloadCharacters) throw new SceneRecipeError('scene payload is too long')
        const normalized = payload.replaceAll('-', '+').replaceAll('_', '/')
        const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
        const bytes = decodeBase64(padded)
        if (bytes[0] === 0x7b) {
            return validateSceneRecipe(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
        }
        const header = bytes[0]
        if (header === undefined) throw new SceneRecipeError('unsupported binary scene version')
        const version = header & ~DEFLATED
        if (version !== WIRE_VERSION && version !== LEGACY_WIRE_VERSION) {
            throw new SceneRecipeError('unsupported binary scene version')
        }
        const deflated = (header & DEFLATED) !== 0
        const body = bytes.subarray(1)
        const packed = deflated ? inflateBounded(body) : body
        const recipe = unpackRecipe(packed, version)
        if (version === LEGACY_WIRE_VERSION) {
            // Legacy links re-encode as wire 2, so appended bytes are caught by re-deflating the wire-1 body.
            if (deflated && !sameBytes(deflateSync(packed, { level: 9 }), body)) {
                throw new SceneRecipeError('non-canonical or trailing binary data')
            }
            return recipe
        }
        if (encodeSceneRecipe(recipe) !== payload) throw new SceneRecipeError('non-canonical or trailing binary data')
        return recipe
    } catch (error) {
        if (error instanceof SceneRecipeError) throw error
        throw new SceneRecipeError(error instanceof Error ? error.message : 'invalid scene payload')
    }
}
