import { unzipSync } from 'fflate'
import type { describe as describeFunction, expect as expectFunction, it as itFunction } from 'vitest'

declare const describe: typeof describeFunction
declare const expect: typeof expectFunction
declare const it: typeof itFunction

import { createBackdropRasterizer } from './backdrop'
import { playbackPhases, sequenceMetadata, spritesheetMetadata, uniquePhases, zip } from './animated'
import { createSpritesheetGrid } from './layout'
import { bodyLocalToLightUv, lightUvToBodyLocal } from './runtime'
import { distributeGifDelays } from './timing'
import type { RenderRequest, SceneRecipeV1 } from './types'

const recipe = (overrides: Partial<SceneRecipeV1['export']> = {}): SceneRecipeV1 => ({
    schema: 'pixelplanetsplus-scene@1',
    celestialType: 'terranWet',
    canvas: { width: 32, height: 24 },
    body: { center: [0.5, 0.5], size: 1, phase: 0, rotation: 0, light: [0.39, 0.39] },
    seed: 7,
    pixels: 32,
    palette: [['#112233', '#445566']],
    layers: [{ id: 'land', visible: true }],
    dither: true,
    backdrop: { kind: 'transparent' },
    export: {
        scale: 1,
        frameCount: 5,
        columns: 3,
        margin: 2,
        startPhase: 0,
        endPhase: 1,
        direction: 'forward',
        framesPerSecond: 10,
        ...overrides,
    },
    effects: [],
})

const request = (overrides: Partial<SceneRecipeV1['export']> = {}): RenderRequest => ({
    id: 'packaging-test',
    recipe: recipe(overrides),
    format: 'png-sequence',
    includeMetadata: true,
    includeLayers: false,
})

const bytes = async (blob: Blob): Promise<Uint8Array> => new Uint8Array(await blob.arrayBuffer())

describe('export packaging', () => {
    it('converts body-local light coordinates at the shader boundary', () => {
        expect(bodyLocalToLightUv([0, 0])).toEqual([0.5, 0.5])
        expect(bodyLocalToLightUv([-0.11, -0.11])).toEqual([0.39, 0.39])
        expect(lightUvToBodyLocal([0.39, 0.39])).toEqual([-0.10999999999999999, -0.10999999999999999])
    })

    it('samples forward, reverse, and ping-pong playback with the requested frame count', () => {
        expect(playbackPhases(request({ direction: 'forward' }))).toHaveLength(5)
        expect(playbackPhases(request({ direction: 'reverse' }))).toHaveLength(5)
        expect(playbackPhases(request({ direction: 'ping-pong', frameCount: 6 }))).toHaveLength(6)
        expect(playbackPhases(request({ direction: 'forward' }))).toEqual([0, 0.2, 0.4, 0.6, 0.8])
        playbackPhases(request({ direction: 'reverse' })).forEach((phase, index) => {
            expect(phase).toBeCloseTo([1, 0.8, 0.6, 0.4, 0.2][index]!, 12)
        })
        expect(uniquePhases(request({ direction: 'ping-pong', frameCount: 6 }))).toEqual([0, 1 / 3, 2 / 3, 1])
    })

    it('samples each ping-pong turnaround endpoint exactly once', () => {
        const phases = playbackPhases(request({ direction: 'ping-pong', frameCount: 6 }))
        expect(phases.filter(phase => phase === 0)).toHaveLength(1)
        expect(phases.filter(phase => phase === 1)).toHaveLength(1)
    })

    it('describes spritesheet layout, playback order, and distributed timing', () => {
        const exportRequest = request({ direction: 'ping-pong', frameCount: 6, columns: 2, margin: 1, framesPerSecond: 10 })
        const metadata = spritesheetMetadata(exportRequest, 8, 6)
        const grid = createSpritesheetGrid(4, 2, 8, 6, 1)

        expect(metadata.schema).toBe('pixelplanetsplus-spritesheet@1')
        expect(metadata.grid).toMatchObject({ columns: grid.columns, rows: grid.rows })
        expect(metadata.frames).toEqual(grid.frames.map((frame, index) => ({
            ...frame,
            phase: uniquePhases(exportRequest)[index],
            durationMilliseconds: 100,
        })))
        expect(metadata.playback.order).toEqual([0, 1, 2, 3, 2, 1])
        expect(spritesheetMetadata(request({ frameCount: 5, columns: 3 }), 8, 6).playback.order)
            .toEqual([0, 1, 2, 3, 4])
        expect(metadata.frames.reduce((total, frame) => total + frame.durationMilliseconds, 0))
            .toBe(distributeGifDelays(10, metadata.frames.length).reduce((total, delay) => total + delay * 10, 0))
    })

    it('describes sequence schema, frame count, and phases', () => {
        const exportRequest = request({ direction: 'reverse', frameCount: 4 })
        const phases = playbackPhases(exportRequest)
        const metadata = sequenceMetadata(exportRequest, 8, 6, phases)

        expect(metadata.schema).toBe('pixelplanetsplus-sequence@1')
        expect(metadata.frames).toHaveLength(4)
        expect(metadata.frames.map(frame => frame.phase)).toEqual(phases)
        expect(metadata.frames.map(frame => frame.index)).toEqual([0, 1, 2, 3])
    })

    it('round-trips ZIP entries and produces deterministic bytes', async () => {
        const entries = {
            'scene.json': new TextEncoder().encode('{"seed":7}\n'),
            'frames/0001.png': new Uint8Array([0, 1, 2, 255]),
        }
        const first = await bytes(await zip(entries))
        const second = await bytes(await zip(entries))
        const unpacked = unzipSync(first)

        expect(unpacked).toEqual(entries)
        expect(second).toEqual(first)
    })

    it('keeps star rasters deterministic, appends density, and changes with seed', async () => {
        const sprite = { width: 1, height: 1, data: new Uint8ClampedArray([255, 255, 255, 255]) }
        const frames = new Map<string, { image: typeof sprite, brightImage: typeof sprite }>()
        for (const special of [0, 1]) {
            for (let frame = 0; frame < (special ? 6 : 9); frame += 1) {
                for (const color of ['#ffef9e', '#ffffff']) frames.set(`${special}:${frame}:${color}`, { image: sprite, brightImage: sprite })
            }
        }
        const backdrop = { kind: 'stars', seed: 17, density: 0.1, brightness: 1, starScale: 1, specialStarMix: 0.2, gradientPhase: 0 } as const
        const denser = { ...backdrop, density: 0.2 }
        const changed = { ...backdrop, seed: 18 }
        const low = (await createBackdropRasterizer(backdrop, 512, 512, frames)).renderBand(0, 512)
        const high = (await createBackdropRasterizer(denser, 512, 512, frames)).renderBand(0, 512)
        const other = (await createBackdropRasterizer(changed, 512, 512, frames)).renderBand(0, 512)
        const populated = (raster: Uint8ClampedArray): number[] => Array.from({ length: raster.length / 4 }, (_, index) => index)
            .filter(index => raster[index * 4 + 3]! > 0)

        expect((await createBackdropRasterizer(backdrop, 512, 512, frames)).renderBand(0, 512)).toEqual(low)
        expect(populated(high).length).toBeGreaterThan(populated(low).length)
        expect(populated(low).every(index => high[index * 4 + 3]! > 0)).toBe(true)
        expect(other).not.toEqual(low)
    })
})
