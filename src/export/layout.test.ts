import type { describe as describeFunction, expect as expectFunction, it as itFunction } from 'vitest'

declare const describe: typeof describeFunction
declare const expect: typeof expectFunction
declare const it: typeof itFunction

import {
    canvasPixelsToComposerBody,
    composerBodyToCanvasPixels,
    createSpritesheetGrid,
    nudgeNormalizedCenter,
    snapBodySizeToIntegerScale,
} from './layout'

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
        const body = { center: [0.31, 0.72] as const, size: 0.43, light: [0.2, -0.3] as const }
        const roundTrip = canvasPixelsToComposerBody(composerBodyToCanvasPixels(body, width, height), width, height)
        expect(roundTrip.center[0]).toBeCloseTo(body.center[0], 12)
        expect(roundTrip.center[1]).toBeCloseTo(body.center[1], 12)
        expect(roundTrip.size).toBeCloseTo(body.size, 12)
        expect(roundTrip.light?.[0]).toBeCloseTo(body.light[0], 12)
        expect(roundTrip.light?.[1]).toBeCloseTo(body.light[1], 12)
    })

    it('snaps to at least 1× and the nearest integer logical multiple', () => {
        expect(snapBodySizeToIntegerScale(20, 32)).toEqual({ scale: 1, size: 32 })
        expect(snapBodySizeToIntegerScale(95, 32)).toEqual({ scale: 3, size: 96 })
        expect(snapBodySizeToIntegerScale(113, 32)).toEqual({ scale: 4, size: 128 })
    })

    it('nudges the normalized center by exactly one canvas pixel', () => {
        const center = [0.5, 0.25] as const
        const nudged = nudgeNormalizedCenter(center, 800, 400, 1, -1)
        expect(nudged[0] * 800 - center[0] * 800).toBe(1)
        expect(nudged[1] * 400 - center[1] * 400).toBe(-1)
    })
})
