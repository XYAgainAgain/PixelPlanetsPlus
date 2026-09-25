import type { describe as describeFunction, expect as expectFunction, it as itFunction } from 'vitest'

declare const describe: typeof describeFunction
declare const expect: typeof expectFunction
declare const it: typeof itFunction

import {
    CHROMATIC_ABERRATION_MIN_WIDTH,
    applyChromaticAberration,
    chromaticAberrationOffset,
    chromaticAberrationSetting,
    effectiveChromaticAberration,
    withChromaticAberration,
} from './effects'
import { decodeSceneRecipe, encodeSceneRecipe } from './recipe'
import { composeBand } from './raster'
import type { SceneRecipeV2 } from './types'

const recipe = (overrides: Partial<SceneRecipeV2> = {}): SceneRecipeV2 => ({
    schema: 'pixelplanetsplus-scene@2',
    celestialType: 'islands',
    canvas: { width: 1920, height: 1080 },
    body: { center: [0.5, 0.5], phase: 0, rotation: 0, light: [0.1, -0.2] },
    seed: 149804,
    pixels: 100,
    palette: [['#8fe4c1', '#4ea5b8', '#2e3a5a', '#c7d05b', '#63ab3f', '#2f5753', '#283540', '#dfe0e8', '#a3a7c2', '#686f99', '#404973', '#a9dfe8', '#0080ff', '#000099']],
    layers: [],
    dither: true,
    backdrop: { base: { kind: 'transparent' }, stars: null },
    export: { scale: 1, frameCount: 60, columns: 8, margin: 0, startPhase: 0, endPhase: 1, direction: 'forward', framesPerSecond: 12 },
    effects: [],
    ...overrides,
})

const row = (...pixels: number[][]): Uint8ClampedArray => Uint8ClampedArray.from(pixels.flat())

describe('chromatic aberration', () => {
    it('rounds 0.001 of the width to whole pixels and is unavailable under 500 px', () => {
        expect(chromaticAberrationOffset(CHROMATIC_ABERRATION_MIN_WIDTH - 1)).toBe(0)
        expect(chromaticAberrationOffset(CHROMATIC_ABERRATION_MIN_WIDTH)).toBe(1)
        expect(chromaticAberrationOffset(1920)).toBe(2)
        expect(chromaticAberrationOffset(8192)).toBe(8)
    })

    it('applies only when the recipe turns it on and the image is wide enough', () => {
        expect(effectiveChromaticAberration(recipe(), 1920)).toBe(0)
        const on = recipe({ effects: withChromaticAberration([], true) })
        expect(effectiveChromaticAberration(on, 1920)).toBe(2)
        expect(effectiveChromaticAberration(on, 300)).toBe(0)
        expect(effectiveChromaticAberration(recipe({ effects: withChromaticAberration([], false) }), 1920)).toBe(0)
    })

    it('replaces an existing entry instead of stacking a second one', () => {
        const effects = withChromaticAberration(withChromaticAberration([{ id: 'grain', version: 1, enabled: true, parameters: {} }], true), false)
        expect(effects.map((effect) => effect.id)).toEqual(['grain', 'chromaticAberration'])
        expect(chromaticAberrationSetting(effects)).toBe(false)
        expect(chromaticAberrationSetting([])).toBeNull()
    })

    it('shifts red left and blue right on opaque pixels, clamping at the image edge', () => {
        const pixels = row([10, 1, 100, 255], [20, 2, 200, 255], [30, 3, 250, 255])
        applyChromaticAberration(pixels, 3, 1, 1)
        expect(Array.from(pixels)).toEqual([20, 1, 100, 255, 30, 2, 100, 255, 30, 3, 200, 255])
    })

    it('never changes alpha and leaves fully transparent pixels untouched', () => {
        const pixels = row([0, 0, 0, 0], [200, 100, 50, 255], [0, 0, 0, 0])
        applyChromaticAberration(pixels, 3, 1, 1)
        // Red borrowed from a transparent neighbor fades to 0, like the live filter over black.
        expect(Array.from(pixels)).toEqual([0, 0, 0, 0, 0, 100, 0, 255, 0, 0, 0, 0])
    })

    it('fades a channel borrowed from a less opaque neighbor by the alpha ratio', () => {
        const pixels = row([0, 0, 0, 255], [200, 0, 0, 51])
        applyChromaticAberration(pixels, 2, 1, 1)
        expect(pixels[0]).toBe(40)
        expect(pixels[3]).toBe(255)
    })

    it('runs on the PNG composite only, leaving passes and masks clean', () => {
        const scene = recipe({
            canvas: { width: 600, height: 4 },
            pixels: 12,
            celestialType: 'terranWet',
            effects: withChromaticAberration([], true),
            backdrop: { base: { kind: 'solid', color: '#000000' }, stars: null },
        })
        const frame = { width: 12, height: 12, pixels: new Uint8ClampedArray(12 * 12 * 4) }
        for (let index = 0; index < frame.pixels.length; index += 4) frame.pixels.set([255, 255, 255, 255], index)
        const solid = { renderBand: (_start: number, rows: number) => {
            const band = new Uint8ClampedArray(600 * rows * 4)
            for (let index = 3; index < band.length; index += 4) band[index] = 255
            return band
        } }
        const composite = composeBand(scene, frame, 0, 4, 'composite', solid)
        const body = composeBand(scene, frame, 0, 4, 'body', null)
        const whiteColumns = (band: Uint8ClampedArray): number[] => {
            const columns: number[] = []
            for (let x = 0; x < 600; x += 1) if (band[x * 4] === 255 && band[x * 4 + 2] === 255) columns.push(x)
            return columns
        }
        // The body's 12 white columns lose one on each side to the color split; the pass keeps all 12.
        expect(whiteColumns(body)).toHaveLength(12)
        expect(whiteColumns(composite)).toHaveLength(10)
    })

    it('rides in the flag byte, so turning it on costs a scene link nothing', () => {
        const plain = encodeSceneRecipe(recipe())
        const on = encodeSceneRecipe(recipe({ effects: withChromaticAberration([], true) }))
        const off = encodeSceneRecipe(recipe({ effects: withChromaticAberration([], false) }))
        expect(on.length).toBe(plain.length)
        expect(off.length).toBe(plain.length)
        expect(chromaticAberrationSetting(decodeSceneRecipe(on).effects)).toBe(true)
        expect(chromaticAberrationSetting(decodeSceneRecipe(off).effects)).toBe(false)
        expect(chromaticAberrationSetting(decodeSceneRecipe(plain).effects)).toBeNull()
    })

    it('round-trips alongside other effects and keeps it last', () => {
        const effects = withChromaticAberration([{ id: 'grain', version: 1, enabled: true, parameters: { amount: 0.5 } }], true)
        const decoded = decodeSceneRecipe(encodeSceneRecipe(recipe({ effects })))
        expect(decoded.effects).toEqual(effects)
    })

    it('leaves noncanonical entries untouched through a composer edit and never applies them', () => {
        const parameterized = [{ id: 'chromaticAberration', version: 1, enabled: true, parameters: { strength: 3 } }]
        const entry = { id: 'chromaticAberration', version: 1, enabled: true, parameters: {} }
        const duplicated = [entry, { ...entry, enabled: false }]
        for (const effects of [parameterized, duplicated]) {
            const decoded = decodeSceneRecipe(encodeSceneRecipe(recipe({ effects }))).effects
            expect(withChromaticAberration(decoded, false)).toEqual(effects)
            expect(chromaticAberrationSetting(decoded)).toBeNull()
            expect(effectiveChromaticAberration(recipe({ effects: decoded }), 1920)).toBe(0)
        }
    })

    it('still toggles the canonical entry in place', () => {
        const effects = withChromaticAberration([{ id: 'grain', version: 1, enabled: true, parameters: {} }], true)
        const toggled = withChromaticAberration(decodeSceneRecipe(encodeSceneRecipe(recipe({ effects }))).effects, false)
        expect(toggled).toEqual([effects[0], { ...effects[1], enabled: false }])
        expect(chromaticAberrationSetting(toggled)).toBe(false)
    })

    it('keeps duplicate entries generic so the link still decodes', () => {
        const entry = { id: 'chromaticAberration', version: 1, enabled: true, parameters: {} }
        const effects = [entry, { ...entry, enabled: false }]
        expect(decodeSceneRecipe(encodeSceneRecipe(recipe({ effects }))).effects).toEqual(effects)
    })

    it('keeps a parameterized or future version as a generic effect', () => {
        const effects = [{ id: 'chromaticAberration', version: 2, enabled: true, parameters: { strength: 2 } }]
        expect(decodeSceneRecipe(encodeSceneRecipe(recipe({ effects }))).effects).toEqual(effects)
    })
})
