import type { describe as describeFunction, expect as expectFunction, it as itFunction } from 'vitest'

declare const describe: typeof describeFunction
declare const expect: typeof expectFunction
declare const it: typeof itFunction

import {
    bodyFrameSize,
    canonicalFrameSize,
    canvasPixelsToComposerBody,
    composerBodyToCanvasPixels,
    createSpritesheetGrid,
    nearestExportScale,
    nudgeNormalizedCenter,
} from './layout'
import { composeBand } from './raster'
import { preflightRenderRequest } from './preflight'
import type { RenderRequest, SceneRecipeV2 } from './types'

const sceneRecipe = (overrides: Partial<SceneRecipeV2> = {}): SceneRecipeV2 => ({
    schema: 'pixelplanetsplus-scene@2',
    celestialType: 'terranWet',
    canvas: { width: 64, height: 48 },
    body: { center: [0.5, 0.5], phase: 0, rotation: 0, light: null },
    seed: 3,
    pixels: 10,
    palette: [],
    layers: [],
    dither: true,
    backdrop: { base: { kind: 'transparent' }, stars: null },
    export: { scale: 4, frameCount: 4, columns: 2, margin: 0, startPhase: 0, endPhase: 1, direction: 'forward', framesPerSecond: 12 },
    effects: [],
    ...overrides,
})

describe('export layout', () => {
    it('derives rows and orders populated cells left-to-right, top-to-bottom', () => {
        const grid = createSpritesheetGrid(5, 3, 10, 8, 2)
        expect(grid.rows).toBe(2)
        expect(grid.frames).toEqual([
            { index: 0, x: 2, y: 2, width: 10, height: 8 },
            { index: 1, x: 14, y: 2, width: 10, height: 8 },
            { index: 2, x: 26, y: 2, width: 10, height: 8 },
            { index: 3, x: 2, y: 12, width: 10, height: 8 },
            { index: 4, x: 14, y: 12, width: 10, height: 8 },
        ])
    })

    it('keeps margins consistent with sheet dimensions and leaves trailing cells empty', () => {
        const grid = createSpritesheetGrid(5, 3, 10, 8, 2)
        expect(grid.width).toBe(38)
        expect(grid.height).toBe(22)
        expect(grid.frames).toHaveLength(5)
        expect(grid.frames.at(-1)).toEqual({ index: 4, x: 14, y: 12, width: 10, height: 8 })
    })

    it('keeps frame count independent of columns', () => {
        expect(createSpritesheetGrid(7, 2, 4, 4, 0).frames).toHaveLength(7)
        expect(createSpritesheetGrid(7, 5, 4, 4, 0).frames).toHaveLength(7)
    })

    it.each([[1920, 1080], [1080, 1920], [1, 10000], [10000, 1]])('round-trips body coordinates at %d×%d', (width, height) => {
        const body = { center: [0.31, 0.72] as const, light: [0.2, -0.3] as const }
        const roundTrip = canvasPixelsToComposerBody(composerBodyToCanvasPixels(body, 400, width, height), width, height)
        expect(roundTrip.center[0]).toBeCloseTo(body.center[0], 12)
        expect(roundTrip.center[1]).toBeCloseTo(body.center[1], 12)
        expect(roundTrip.light?.[0]).toBeCloseTo(body.light[0], 12)
        expect(roundTrip.light?.[1]).toBeCloseTo(body.light[1], 12)
    })

    it('sizes the body in the file as its whole drawn extent × zoom', () => {
        expect(bodyFrameSize('terranWet', 100, 4)).toBe(400)
        expect(bodyFrameSize('gasGiant2', 100, 2)).toBe(600)
        expect(bodyFrameSize('star', 33, 8)).toBe(528)
        // The accretion disk quad is 3× the core, so the frame is too, matching what the live view shows.
        expect(canonicalFrameSize('blackHole', 12)).toBe(36)
        expect(canonicalFrameSize('blackHole', 100)).toBe(300)
    })

    it('pads Islands by whole cells so its atmosphere rim is never cropped', () => {
        // The rim reaches 0.02 quad units past each edge, plus one cell for pixelize's floor.
        expect(canonicalFrameSize('islands', 100)).toBe(106)
        expect(canonicalFrameSize('islands', 12)).toBe(16)
        for (const pixels of [12, 100, 137, 2048]) {
            const margin = (canonicalFrameSize('islands', pixels) - pixels) / 2
            expect(Number.isInteger(margin)).toBe(true)
            expect(margin).toBeGreaterThanOrEqual(0.02 * pixels + 1)
        }
    })

    it('migrates a free-form body size to the nearest whole-number zoom', () => {
        expect(nearestExportScale(100, 100)).toBe(1)
        expect(nearestExportScale(10, 100)).toBe(1)
        expect(nearestExportScale(290, 100)).toBe(4)
        expect(nearestExportScale(270, 100)).toBe(2)
        expect(nearestExportScale(5000, 100)).toBe(8)
    })

    it('agrees with preflight and the compositor on the body frame size', () => {
        const recipe = sceneRecipe()
        const request: RenderRequest = { id: 't', recipe, format: 'gif', includeMetadata: false, includeLayers: false }
        expect(preflightRenderRequest(request, { maxTextureDimension2D: 4096 }).estimate.frame.width).toBe(bodyFrameSize('terranWet', 10, 4))
        // A 10×10 canonical frame of opaque texels at 4× lands as an exact 40×40 block centered on the canvas.
        const frame = { width: 10, height: 10, pixels: new Uint8ClampedArray(10 * 10 * 4).fill(255) }
        const band = composeBand(recipe, frame, 0, 48, 'mask', null)
        const covered: number[] = []
        for (let index = 0; index < 64 * 48; index += 1) if (band[index * 4 + 3] === 255) covered.push(index)
        expect(covered).toHaveLength(40 * 40)
        expect(covered[0]).toBe(4 * 64 + 12)
        expect(covered.at(-1)).toBe(43 * 64 + 51)
    })

    it('nudges the normalized center by exactly one canvas pixel', () => {
        const center = [0.5, 0.25] as const
        const nudged = nudgeNormalizedCenter(center, 800, 400, 1, -1)
        expect(nudged[0] * 800 - center[0] * 800).toBe(1)
        expect(nudged[1] * 400 - center[1] * 400).toBe(-1)
    })
})
