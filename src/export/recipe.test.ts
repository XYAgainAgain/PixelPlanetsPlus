import type { describe as describeFunction, expect as expectFunction, it as itFunction } from 'vitest'

declare const describe: typeof describeFunction
declare const expect: typeof expectFunction
declare const it: typeof itFunction
import { deflateSync } from 'fflate'
import {
    decodeSceneRecipe,
    SCENE_LIMITS,
    encodeSceneRecipe,
    SceneRecipeError,
    validateSceneRecipe,
} from './recipe'
import type { SceneRecipeV2 } from './types'
import { defaultPaletteFor } from './worldParams'

const validRecipe = (): SceneRecipeV2 => ({
    schema: 'pixelplanetsplus-scene@2',
    celestialType: 'terranWet',
    canvas: { width: 128, height: 128 },
    body: {
        center: [0.5, 0.5],
        phase: 0,
        rotation: 0,
        light: [0.39, 0.39],
    },
    seed: 1,
    pixels: 128,
    palette: [['#112233', '#445566']],
    layers: [{ id: 'land', visible: true }],
    dither: true,
    backdrop: { base: { kind: 'transparent' }, stars: null },
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

type MutableRecipe = Omit<SceneRecipeV2, 'canvas' | 'body' | 'palette' | 'layers' | 'export' | 'effects'> & {
    canvas: { width: number, height: number }
    body: { center: [number, number], phase: number, rotation: number, light: [number, number] | null }
    palette: string[][]
    layers: { id: string, visible: boolean }[]
    export: { scale: SceneRecipeV2['export']['scale'], frameCount: number, columns: number, margin: number, startPhase: number, endPhase: number, direction: SceneRecipeV2['export']['direction'], framesPerSecond: number }
    effects: { id: string, version: number, enabled: boolean, parameters: Record<string, boolean | number | string> }[]
}

const invalidRecipe = (mutate: (recipe: MutableRecipe) => void): SceneRecipeV2 => {
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
            center: [0.123456, -0.654321], phase: 0.876543,
            rotation: -0.123456, light: [0.333333, 0.666666],
        }
        recipe.backdrop = {
            base: { kind: 'gradient', phase: 0.777777 },
            stars: { seed: 42, density: 0.123456, brightness: 0.987654, starScale: 1.234567, specialStarMix: 0.456789 },
        }
        recipe.export = { ...recipe.export, startPhase: 0.111111, endPhase: 0.999999, framesPerSecond: 23.97654 }
        ;(recipe.effects[0]!.parameters as Record<string, boolean | number | string>).amount = 0.555555
        expect(decodeSceneRecipe(encodeSceneRecipe(recipe))).toEqual({
            ...recipe,
            body: { center: [0.1235, -0.6543], phase: 0.8765, rotation: -0.1235, light: [0.3333, 0.6667] },
            backdrop: {
                base: { kind: 'gradient', phase: 0.7778 },
                stars: { seed: 42, density: 0.1235, brightness: 0.9877, starScale: 1.2346, specialStarMix: 0.4568 },
            },
            export: { ...recipe.export, startPhase: 0.1111, endPhase: 1, framesPerSecond: 23.9765 },
            effects: [{ ...recipe.effects[0]!, parameters: { amount: 0.5556 } }],
        })
    })

    it('rejects values that quantize into an invalid recipe', () => {
        const recipe = validRecipe()
        recipe.canvas = { width: 1, height: 1 }
        ;(recipe.export as { scale: number }).scale = 3
        expect(() => encodeSceneRecipe(recipe)).toThrow(/export\.scale/)
    })

    it('rejects bytes appended after a compressed payload', () => {
        const payload = encodeSceneRecipe(validRecipe())
        expect(() => decodeSceneRecipe(`${payload}AAAA`)).toThrow(/trailing binary data/)
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
        ['unknown binary version', base64Url(new Uint8Array([3, 0]))],
        ['wrong schema', jsonPayload({ ...validRecipe(), schema: 'wrong' })],
    ])('rejects %s with SceneRecipeError only', (_name, payload) => {
        expectSceneRecipeError(() => decodeSceneRecipe(payload))
    })

    it.each([
        ['canvas dimension', invalidRecipe(recipe => { recipe.canvas.width = 32_769 })],
        ['canvas pixel count', invalidRecipe(recipe => { recipe.canvas = { width: 16_384, height: 16_385 } })],
        ['export scale', invalidRecipe(recipe => { recipe.export.scale = 3 as SceneRecipeV2['export']['scale'] })],
        ['palette color', invalidRecipe(recipe => { recipe.palette[0]![0] = '#12345' })],
        ['solid backdrop color', invalidRecipe(recipe => { recipe.backdrop = { base: { kind: 'solid', color: 'red' }, stars: null } })],
        ['duplicate layer ids', invalidRecipe(recipe => { recipe.layers.push({ id: 'land', visible: false }) })],
        ['non-finite effect parameter', invalidRecipe(recipe => { recipe.effects[0]!.parameters.amount = Infinity })],
        ['unknown celestial type', invalidRecipe(recipe => { recipe.celestialType = 'unknown' as SceneRecipeV2['celestialType'] })],
    ])('rejects %s', (_name, recipe) => {
        expectSceneRecipeError(() => validateSceneRecipe(recipe))
    })

    const stars = { seed: 2, density: 0.5, brightness: 1, starScale: 1, specialStarMix: 0.2 }
    it.each([
        ['transparent', { base: { kind: 'transparent' }, stars: null }],
        ['stars on transparent', { base: { kind: 'transparent' }, stars }],
        ['solid', { base: { kind: 'solid', color: '#abcdef' }, stars: null }],
        ['stars on solid', { base: { kind: 'solid', color: '#abcdef' }, stars }],
        ['gradient', { base: { kind: 'gradient', phase: 0.25 }, stars: null }],
        ['stars on gradient', { base: { kind: 'gradient', phase: 0.25 }, stars }],
    ] as const)('validates and round-trips the %s backdrop', (_name, backdrop) => {
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
        maximal.body = { center: [-12.3456, 98.7654], phase: 123.4567, rotation: -6.2832, light: [-0.85, 0.85] }
        maximal.seed = Number.MAX_SAFE_INTEGER
        maximal.pixels = 16_384
        maximal.palette = [Array.from({ length: 10 }, (_, color) =>
            `#${(color * 0x192b3d & 0xffffff).toString(16).padStart(6, '0')}`)]
        maximal.layers = [{ id: 'Land', visible: false }, { id: 'Cloud', visible: true }]
        maximal.dither = false
        maximal.backdrop = { base: { kind: 'gradient', phase: 123.4567 }, stars: { seed: 4_294_967_295, density: 0.8765, brightness: 2.3456, starScale: 8.7654, specialStarMix: 0.6543 } }
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

    it.each([0, -12, 0.00001, 0.99999, 100.5, Infinity])('rejects %s frames per second', framesPerSecond => {
        const recipe = invalidRecipe(value => { value.export.framesPerSecond = framesPerSecond })
        expectSceneRecipeError(() => validateSceneRecipe(recipe))
        // 0.99999 quantizes to exactly 1 on the wire, which is a valid rate; the rest stay out of range.
        if (framesPerSecond !== 0.99999) expectSceneRecipeError(() => encodeSceneRecipe(recipe))
    })

    describe('hostile payloads', () => {
        // Wire-2 body: palette group only, Terran Wet, a 1×1 canvas, seed 0, 1 pixel, zeroed geometry, no light.
        const header = [1, 0, 0, 1, 1, 0, 1, 0, 0, 0, 0]
        const wire = (packed: Uint8Array): string => base64Url(new Uint8Array([0x82, ...deflateSync(packed, { level: 9 })]))

        it('rejects an over-long link before decoding it', () => {
            expectSceneRecipeError(() => decodeSceneRecipe('A'.repeat(SCENE_LIMITS.payloadCharacters + 1)))
        })

        it('refuses a tiny payload that inflates past the packed-size ceiling', () => {
            const bomb = wire(new Uint8Array(1_000_000))
            expect(bomb.length).toBeLessThan(SCENE_LIMITS.payloadCharacters)
            expect(() => decodeSceneRecipe(bomb)).toThrow(/inflates past its limit/)
        })

        it('refuses a palette count far beyond the schema before allocating it', () => {
            // 1,000,000 as a varint, followed by enough zero bytes to look plausible.
            const packed = new Uint8Array([...header, 0xc0, 0x84, 0x3d, ...new Uint8Array(10_000)])
            expect(() => decodeSceneRecipe(wire(packed))).toThrow(/too many palette groups/)
        })

        it('refuses counts within the schema that the remaining bytes cannot hold', () => {
            const packed = new Uint8Array([...header, 1, SCENE_LIMITS.paletteColors, 0, 0, 0])
            expect(() => decodeSceneRecipe(wire(packed))).toThrow(/too many palette colors/)
        })

        it.each([
            ['palette groups', invalidRecipe(recipe => { recipe.palette = Array.from({ length: SCENE_LIMITS.paletteGroups + 1 }, () => ['#000000']) })],
            ['palette colors', invalidRecipe(recipe => { recipe.palette = [Array.from({ length: SCENE_LIMITS.paletteColors + 1 }, () => '#000000')] })],
            ['layers', invalidRecipe(recipe => { recipe.layers = Array.from({ length: SCENE_LIMITS.layers + 1 }, (_, index) => ({ id: `layer-${index}`, visible: true })) })],
            ['effects', invalidRecipe(recipe => { recipe.effects = Array.from({ length: SCENE_LIMITS.effects + 1 }, (_, index) => ({ id: `e${index}`, version: 1, enabled: true, parameters: {} })) })],
            ['effect parameters', invalidRecipe(recipe => { recipe.effects[0]!.parameters = Object.fromEntries(Array.from({ length: SCENE_LIMITS.effectParameters + 1 }, (_, index) => [`p${index}`, 1])) })],
            ['long strings', invalidRecipe(recipe => { recipe.effects[0]!.id = 'x'.repeat(SCENE_LIMITS.textBytes + 1) })],
            ['frame counts', invalidRecipe(recipe => { recipe.export.frameCount = SCENE_LIMITS.frameCount + 1 })],
        ])('caps oversized %s in JSON recipes', (_name, recipe) => {
            expectSceneRecipeError(() => decodeSceneRecipe(jsonPayload(recipe)))
        })
    })

    describe('scene@1 migration', () => {
        const legacyRecipe = (backdrop: unknown, size = 0.5) => ({
            ...validRecipe(),
            schema: 'pixelplanetsplus-scene@1',
            body: { ...validRecipe().body, size },
            backdrop,
        })
        const legacyStars = { seed: 9, density: 1, brightness: 1, starScale: 1, specialStarMix: 0.5, gradientPhase: 0.3 }

        it.each([
            ['transparent', { kind: 'transparent' }, { base: { kind: 'transparent' }, stars: null }],
            ['solid', { kind: 'solid', color: '#ABCDEF' }, { base: { kind: 'solid', color: '#abcdef' }, stars: null }],
            ['stars', { kind: 'stars', ...legacyStars }, { base: { kind: 'transparent' }, stars: { seed: 9, density: 1, brightness: 1, starScale: 1, specialStarMix: 0.5 } }],
            ['gradient', { kind: 'gradient', ...legacyStars }, { base: { kind: 'gradient', phase: 0.3 }, stars: null }],
            ['stars-gradient', { kind: 'stars-gradient', ...legacyStars }, { base: { kind: 'gradient', phase: 0.3 }, stars: { seed: 9, density: 1, brightness: 1, starScale: 1, specialStarMix: 0.5 } }],
        ] as const)('migrates the legacy %s backdrop to base plus stars', (_name, legacy, migrated) => {
            const recipe = decodeSceneRecipe(jsonPayload(legacyRecipe(legacy)))
            expect(recipe.schema).toBe('pixelplanetsplus-scene@2')
            expect(recipe.backdrop).toEqual(migrated)
            expect(recipe.body).not.toHaveProperty('size')
        })

        it('turns a legacy body size into the nearest whole-number zoom', () => {
            // 128 px canvas, 128 px planet: size 1 → 1×, 2.1 → 2×, 3.2 → 4×, 40 → 8×.
            expect([1, 2.1, 3.2, 40].map(size => decodeSceneRecipe(jsonPayload(legacyRecipe({ kind: 'transparent' }, size))).export.scale))
                .toEqual([1, 2, 4, 8])
        })

        it('still rejects a non-positive legacy body size', () => {
            expectSceneRecipeError(() => validateSceneRecipe(legacyRecipe({ kind: 'transparent' }, 0)))
        })

        it.each([
            // Written by the wire-1 encoder before this migration (a Ringed Gas Giant view and a Black Hole with custom colors).
            ['ringed world', 'gWNhZv3F1cCvlTLBb4LfnRmMs6IZJpYdkWDSWjCHEYIm-DEAAA'],
            ['custom palette', 'geNk5tzBsYODMWWC3wS_HVMY_7gwtKu3qzNyMDAw_P72X1c3A0ie2P-prGA7kM3JKcnwASS3YA4jQ8MyWQA'],
        ])('decodes a real wire-1 %s link and re-encodes it as wire 2', (_name, payload) => {
            const recipe = decodeSceneRecipe(payload)
            expect(recipe.schema).toBe('pixelplanetsplus-scene@2')
            expect([1, 2, 4, 8]).toContain(recipe.export.scale)
            const reencoded = encodeSceneRecipe(recipe)
            expect(reencoded).not.toBe(payload)
            expect(decodeSceneRecipe(reencoded)).toEqual(recipe)
        })

        it('rejects bytes appended after a compressed wire-1 payload', () => {
            expectSceneRecipeError(() => decodeSceneRecipe('gWNhZv3F1cCvlTLBb4LfnRmMs6IZJpYdkWDSWjCHEYIm-DEAAAAAAA'))
        })
    })
})
