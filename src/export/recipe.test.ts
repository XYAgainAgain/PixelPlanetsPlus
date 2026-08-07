import type { describe as describeFunction, expect as expectFunction, it as itFunction } from 'vitest'

declare const describe: typeof describeFunction
declare const expect: typeof expectFunction
declare const it: typeof itFunction
import {
    decodeSceneRecipe,
    encodeSceneRecipe,
    SceneRecipeError,
    validateSceneRecipe,
} from './recipe'
import type { SceneRecipeV1 } from './types'
import { defaultPaletteFor } from './worldParams'

const validRecipe = (): SceneRecipeV1 => ({
    schema: 'pixelplanetsplus-scene@1',
    celestialType: 'terranWet',
    canvas: { width: 128, height: 128 },
    body: {
        center: [0.5, 0.5],
        size: 1,
        phase: 0,
        rotation: 0,
        light: [0.39, 0.39],
    },
    seed: 1,
    pixels: 128,
    palette: [['#112233', '#445566']],
    layers: [{ id: 'land', visible: true }],
    dither: true,
    backdrop: { kind: 'transparent' },
    export: {
        scale: 1,
        frameCount: 1,
        columns: 1,
        margin: 0,
        startPhase: 0,
        endPhase: 1,
        direction: 'forward',
        framesPerSecond: 12,
    },
    effects: [{ id: 'grain', version: 1, enabled: true, parameters: { amount: 0.5 } }],
})

type MutableRecipe = Omit<SceneRecipeV1, 'canvas' | 'body' | 'palette' | 'layers' | 'export' | 'effects'> & {
    canvas: { width: number, height: number }
    body: { center: [number, number], size: number, phase: number, rotation: number, light: [number, number] | null }
    palette: string[][]
    layers: { id: string, visible: boolean }[]
    export: { scale: SceneRecipeV1['export']['scale'], frameCount: number, columns: number, margin: number, startPhase: number, endPhase: number, direction: SceneRecipeV1['export']['direction'], framesPerSecond: number }
    effects: { id: string, version: number, enabled: boolean, parameters: Record<string, boolean | number | string> }[]
}

const invalidRecipe = (mutate: (recipe: MutableRecipe) => void): SceneRecipeV1 => {
    const recipe = structuredClone(validRecipe())
    mutate(recipe as MutableRecipe)
    return recipe
}

const base64Url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')

const jsonPayload = (value: unknown): string => base64Url(new TextEncoder().encode(JSON.stringify(value)))

const expectSceneRecipeError = (callback: () => unknown): void => {
    try {
        callback()
        throw new Error('expected SceneRecipeError')
    } catch (error) {
        expect(error).toBeInstanceOf(SceneRecipeError)
    }
}

describe('scene recipe export', () => {
    it('round-trips a recipe at wire precision', () => {
        const recipe = validRecipe()
        recipe.body = {
            center: [0.123456, -0.654321], size: 1.234567, phase: 0.876543,
            rotation: -0.123456, light: [0.333333, 0.666666],
        }
        recipe.backdrop = {
            kind: 'stars-gradient', seed: 42, density: 0.123456, brightness: 0.987654,
            starScale: 1.234567, specialStarMix: 0.456789, gradientPhase: 0.777777,
        }
        recipe.export = { ...recipe.export, startPhase: 0.111111, endPhase: 0.999999, framesPerSecond: 23.97654 }
        ;(recipe.effects[0]!.parameters as Record<string, boolean | number | string>).amount = 0.555555
        expect(decodeSceneRecipe(encodeSceneRecipe(recipe))).toEqual({
            ...recipe,
            body: { center: [0.1235, -0.6543], size: 1.2346, phase: 0.8765, rotation: -0.1235, light: [0.3333, 0.6667] },
            backdrop: { kind: 'stars-gradient', seed: 42, density: 0.1235, brightness: 0.9877, starScale: 1.2346, specialStarMix: 0.4568, gradientPhase: 0.7778 },
            export: { ...recipe.export, startPhase: 0.1111, endPhase: 1, framesPerSecond: 23.9765 },
            effects: [{ ...recipe.effects[0]!, parameters: { amount: 0.5556 } }],
        })
    })

    it('rejects values that quantize into an invalid recipe', () => {
        const recipe = validRecipe()
        recipe.body.size = 0.00004
        expect(() => encodeSceneRecipe(recipe)).toThrow(/body\.size: expected a positive number/)
    })

    it('rejects bytes appended after a compressed payload', () => {
        const payload = encodeSceneRecipe(validRecipe())
        expect(() => decodeSceneRecipe(`${payload}AAAA`)).toThrow('non-canonical or trailing binary data')
    })

    it('decodes legacy JSON-base64url payloads', () => {
        const recipe = validRecipe()
        expect(decodeSceneRecipe(jsonPayload(recipe))).toEqual(recipe)
    })

    it('encodes payloads as unpadded base64url', () => {
        const payload = encodeSceneRecipe(validRecipe())
        expect(payload).not.toMatch(/[+/=]/)
    })

    it.each([
        ['bad base64', '%%%'],
        ['truncated JSON', jsonPayload('{')],
        ['non-UTF-8 bytes', base64Url(new Uint8Array([0xff, 0xfe]))],
        ['truncated binary', base64Url(new Uint8Array([1]))],
        ['unknown binary version', base64Url(new Uint8Array([2, 0]))],
        ['wrong schema', jsonPayload({ ...validRecipe(), schema: 'wrong' })],
    ])('rejects %s with SceneRecipeError only', (_name, payload) => {
        expectSceneRecipeError(() => decodeSceneRecipe(payload))
    })

    it.each([
        ['canvas dimension', invalidRecipe(recipe => { recipe.canvas.width = 32_769 })],
        ['canvas pixel count', invalidRecipe(recipe => { recipe.canvas = { width: 16_384, height: 16_385 } })],
        ['export scale', invalidRecipe(recipe => { recipe.export.scale = 3 as SceneRecipeV1['export']['scale'] })],
        ['palette color', invalidRecipe(recipe => { recipe.palette[0]![0] = '#12345' })],
        ['solid backdrop color', invalidRecipe(recipe => { recipe.backdrop = { kind: 'solid', color: 'red' } })],
        ['duplicate layer ids', invalidRecipe(recipe => { recipe.layers.push({ id: 'land', visible: false }) })],
        ['non-finite effect parameter', invalidRecipe(recipe => { recipe.effects[0]!.parameters.amount = Infinity })],
        ['non-positive body size', invalidRecipe(recipe => { recipe.body.size = 0 })],
        ['unknown celestial type', invalidRecipe(recipe => { recipe.celestialType = 'unknown' as SceneRecipeV1['celestialType'] })],
    ])('rejects %s', (_name, recipe) => {
        expectSceneRecipeError(() => validateSceneRecipe(recipe))
    })

    it.each([
        { kind: 'transparent' },
        { kind: 'solid', color: '#abcdef' },
        { kind: 'stars', seed: 2, density: 0.5, brightness: 1, starScale: 1, specialStarMix: 0.2, gradientPhase: 0 },
    ] as const)('validates and round-trips the $kind backdrop', backdrop => {
        const recipe = validRecipe()
        recipe.backdrop = backdrop
        expect(decodeSceneRecipe(encodeSceneRecipe(recipe))).toEqual(recipe)
    })

    it('keeps compact and maximal scenes within the URL size budgets', () => {
        const compact = validRecipe()
        compact.palette = [[
            '#63ab3f', '#3b7d4f', '#2f5753', '#283540', '#4fa4b8',
            '#404973', '#f5ffe8', '#dfe0e8', '#686f99', '#404973',
        ]]
        compact.layers = [{ id: 'Land', visible: true }, { id: 'Cloud', visible: true }]
        compact.effects = []
        compact.export = {
            scale: 1, frameCount: 60, columns: 8, margin: 0,
            startPhase: 0, endPhase: 1, direction: 'forward', framesPerSecond: 12,
        }

        const maximal = validRecipe()
        maximal.canvas = { width: 32_768, height: 8_192 }
        maximal.body = { center: [-12.3456, 98.7654], size: 7.6543, phase: 123.4567, rotation: -6.2832, light: [-0.85, 0.85] }
        maximal.seed = Number.MAX_SAFE_INTEGER
        maximal.pixels = 16_384
        maximal.palette = [Array.from({ length: 10 }, (_, color) =>
            `#${(color * 0x192b3d & 0xffffff).toString(16).padStart(6, '0')}`)]
        maximal.layers = [{ id: 'Land', visible: false }, { id: 'Cloud', visible: true }]
        maximal.dither = false
        maximal.backdrop = { kind: 'stars-gradient', seed: 4_294_967_295, density: 0.8765, brightness: 2.3456, starScale: 8.7654, specialStarMix: 0.6543, gradientPhase: 123.4567 }
        maximal.export = { scale: 8, frameCount: 999, columns: 31, margin: 128, startPhase: -10.1234, endPhase: 20.5678, direction: 'ping-pong', framesPerSecond: 59.94 }
        maximal.effects = Array.from({ length: 3 }, (_, index) => ({
            id: `effect-${index}`, version: index + 1, enabled: index % 2 === 0,
            parameters: { amount: index + 0.1234, active: index % 2 === 0, mode: `mode-${index}` },
        }))

        expect(encodeSceneRecipe(compact).length).toBeLessThan(80)
        expect(encodeSceneRecipe(maximal).length).toBeLessThan(400)
    })

    it('omits the complete default palette from the binary payload', () => {
        const compact = validRecipe()
        compact.celestialType = 'islands'
        compact.palette = defaultPaletteFor('islands')
        compact.layers = [
            { id: 'Water', visible: true },
            { id: 'Land', visible: true },
            { id: 'Cloud', visible: true },
        ]
        compact.effects = []
        expect(encodeSceneRecipe(compact).length).toBeLessThan(60)
    })
})
