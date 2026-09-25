import type { describe as describeFunction, expect as expectFunction, it as itFunction } from 'vitest'

declare const describe: typeof describeFunction
declare const expect: typeof expectFunction
declare const it: typeof itFunction

import {
    alphaBounds,
    bodyFrameSize,
    canonicalFrameSize,
    createSpritesheetGrid,
    fitCanvasToArt,
    placeBody,
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

    it('measures the tight alpha box of a frame and reports an empty one as null', () => {
        const pixels = new Uint8ClampedArray(6 * 5 * 4)
        pixels[(1 * 6 + 2) * 4 + 3] = 1
        pixels[(3 * 6 + 4) * 4 + 3] = 255
        expect(alphaBounds(pixels, 6, 5)).toEqual({ x: 2, y: 1, width: 3, height: 3 })
        expect(alphaBounds(new Uint8ClampedArray(16), 2, 2)).toBeNull()
    })

    it('falls back to the whole frame when no art box is known', () => {
        expect(placeBody([0.5, 0.5], 64, 48, 10, 4, null)).toEqual({ left: 12, top: 4, size: 40, art: { x: 0, y: 0, width: 10, height: 10 } })
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

    // Deep-Fold's disc fills texels 1…N−1 of its frame, the case that used to hug the right and bottom edges.
    const discFrame = (cells: number, first: number): { width: number, height: number, pixels: Uint8ClampedArray } => {
        const pixels = new Uint8ClampedArray(cells * cells * 4)
        for (let y = first; y < cells; y += 1) for (let x = first; x < cells; x += 1) pixels[(y * cells + x) * 4 + 3] = 255
        return { width: cells, height: cells, pixels }
    }
    const coverage = (recipe: SceneRecipeV2, frame: ReturnType<typeof discFrame>) => {
        const { width, height } = recipe.canvas
        const band = composeBand(recipe, frame, 0, height, 'mask', null)
        let minX = width, minY = height, maxX = -1, maxY = -1
        for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
            if (band[(y * width + x) * 4 + 3] === 0) continue
            minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y)
        }
        return { left: minX, top: minY, right: width - 1 - maxX, bottom: height - 1 - maxY }
    }

    it.each([[1, 10], [2, 10], [4, 7], [8, 13], [1, 106]] as const)('fits the canvas to the art with zero margin at %d× zoom (%d cells)', (scale, cells) => {
        const frame = discFrame(cells, 1)
        const art = alphaBounds(frame.pixels, frame.width, frame.height)
        const canvas = fitCanvasToArt(cells, scale, art)
        expect(canvas).toEqual({ width: (cells - 1) * scale, height: (cells - 1) * scale })
        const recipe = sceneRecipe({ canvas, export: { ...sceneRecipe().export, scale } })
        expect(coverage(recipe, frame)).toEqual({ left: 0, top: 0, right: 0, bottom: 0 })
    })

    it('splits leftover evenly when centered, with an odd spare pixel on the right and bottom', () => {
        const frame = discFrame(10, 1)
        const even = coverage(sceneRecipe({ canvas: { width: 40, height: 42 } }), frame)
        expect(even).toEqual({ left: 2, top: 3, right: 2, bottom: 3 })
        const odd = coverage(sceneRecipe({ canvas: { width: 41, height: 43 } }), frame)
        expect(odd).toEqual({ left: 2, top: 3, right: 3, bottom: 4 })
    })
})
