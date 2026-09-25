import { unzipSync } from 'fflate'
import type { describe as describeFunction, expect as expectFunction, it as itFunction } from 'vitest'

declare const describe: typeof describeFunction
declare const expect: typeof expectFunction
declare const it: typeof itFunction

import { createBackdropRasterizer } from './backdrop'
import { playbackPhases, sequenceMetadata, spritesheetMetadata, uniquePhases, zip } from './animated'
import { createSpritesheetGrid } from './layout'
import { bodyLocalToLightUv, lightUvToBodyLocal } from './runtime'
import { exportFilename, sequenceFrameFilename } from './filenames'
import type { ExportFormat, RenderRequest, SceneRecipeV2, SequenceMetadataV2, SpritesheetMetadataV2 } from './types'

const recipe = (overrides: Partial<SceneRecipeV2['export']> = {}): SceneRecipeV2 => ({
    schema: 'pixelplanetsplus-scene@2',
    celestialType: 'terranWet',
    canvas: { width: 32, height: 24 },
    body: { center: [0.5, 0.5], phase: 0, rotation: 0, light: [0.39, 0.39] },
    seed: 7,
    pixels: 32,
    palette: [['#112233', '#445566']],
    layers: [{ id: 'land', visible: true }],
    dither: true,
    backdrop: { base: { kind: 'transparent' }, stars: null },
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

const request = (overrides: Partial<SceneRecipeV2['export']> = {}): RenderRequest => ({
    id: 'packaging-test',
    recipe: recipe(overrides),
    format: 'png-sequence',
    includeMetadata: true,
    includeLayers: false,
})

const bytes = async (blob: Blob): Promise<Uint8Array> => new Uint8Array(await blob.arrayBuffer())

// A consumer's view: rebuild every cell rectangle from the JSON document alone, nothing else.
const sliceFromMetadata = (json: string) => {
    const metadata = JSON.parse(json) as SpritesheetMetadataV2
    const { count, columns, margin } = metadata.grid
    const { width, height } = metadata.frame
    return Array.from({ length: count }, (_, index) => ({
        index,
        x: margin + (index % columns) * (width + margin),
        y: margin + Math.floor(index / columns) * (height + margin),
        width,
        height,
        phase: metadata.phases.first + index * metadata.phases.step,
    }))
}

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

    it('lets a consumer slice the v2 spritesheet from its metadata alone', () => {
        for (const overrides of [
            { direction: 'ping-pong', frameCount: 6, columns: 2, margin: 1 },
            { direction: 'forward', frameCount: 5, columns: 3, margin: 2 },
            { direction: 'reverse', frameCount: 7, columns: 4, margin: 0, startPhase: 0.25, endPhase: 0.75 },
        ] as const) {
            const exportRequest = request(overrides)
            const metadata = spritesheetMetadata(exportRequest, 8, 6)
            const grid = createSpritesheetGrid(uniquePhases(exportRequest).length, overrides.columns, 8, 6, overrides.margin)
            const slices = sliceFromMetadata(JSON.stringify(metadata))

            expect(metadata.schema).toBe('pixelplanetsplus-spritesheet@2')
            expect(metadata.image).toEqual({ width: grid.width, height: grid.height })
            expect(slices.map(({ phase: _phase, ...rect }) => rect)).toEqual(grid.frames)
            slices.forEach((slice, index) => { expect(slice.phase).toBeCloseTo(uniquePhases(exportRequest)[index]!, 12) })
            // Every slice lies inside the image the metadata declares.
            expect(slices.every(slice => slice.x + slice.width <= metadata.image.width && slice.y + slice.height <= metadata.image.height)).toBe(true)
        }
    })

    it('keeps v2 spritesheet metadata compact and states playback order only when it is not identity', () => {
        const pingPong = spritesheetMetadata(request({ direction: 'ping-pong', frameCount: 6, columns: 2, margin: 1, framesPerSecond: 10 }), 8, 6)
        expect(pingPong.playback.order).toEqual([0, 1, 2, 3, 2, 1])
        expect(pingPong.playback.frameDurationMilliseconds).toBe(100)
        expect(spritesheetMetadata(request({ frameCount: 5, columns: 3 }), 8, 6).playback.order).toBeUndefined()
        const large = spritesheetMetadata(request({ frameCount: 64, columns: 8 }), 400, 400)
        expect(JSON.stringify(large).length).toBeLessThan(700)
    })

    it.each(['forward', 'reverse', 'ping-pong'] as const)('derives %s playback order structurally when start equals end', direction => {
        const metadata = spritesheetMetadata(request({ direction, frameCount: 6, startPhase: 0.4, endPhase: 0.4 }), 8, 6)
        expect(metadata.phases).toEqual({ first: 0.4, step: 0 })
        if (direction === 'ping-pong') {
            expect(metadata.grid.count).toBe(4)
            expect(metadata.playback.order).toEqual([0, 1, 2, 3, 2, 1])
        } else {
            expect(metadata.grid.count).toBe(6)
            expect(metadata.playback).not.toHaveProperty('order')
        }
    })

    it('describes the v2 sequence by filename pattern and phase range', () => {
        const exportRequest = request({ direction: 'reverse', frameCount: 4 })
        const phases = playbackPhases(exportRequest)
        const metadata: SequenceMetadataV2 = sequenceMetadata(exportRequest, 8, 6, phases)

        expect(metadata.schema).toBe('pixelplanetsplus-sequence@2')
        expect(metadata.files.count).toBe(4)
        const names = Array.from({ length: metadata.files.count }, (_, index) =>
            `${metadata.files.prefix}${String(index + 1).padStart(metadata.files.digits, '0')}.png`)
        expect(names).toEqual(phases.map((_, index) => sequenceFrameFilename(exportRequest.recipe, index)))
        const range = metadata.phases as { first: number, step: number }
        phases.forEach((phase, index) => { expect(range.first + index * range.step).toBeCloseTo(phase, 12) })

        const pingPong = playbackPhases(request({ direction: 'ping-pong', frameCount: 6 }))
        expect(sequenceMetadata(request({ direction: 'ping-pong', frameCount: 6 }), 8, 6, pingPong).phases).toEqual(pingPong)
    })

    it('gives every export format its own deterministic filename', () => {
        const recipe = { celestialType: 'lavaWorld', seed: 149804 } as const
        const formats: ExportFormat[] = ['png', 'gif', 'scene-package', 'spritesheet', 'png-sequence']
        expect(formats.map(format => exportFilename(recipe, format))).toEqual([
            'lava-149804.png', 'lava-149804.gif', 'lava-149804-scene.zip', 'lava-149804-spritesheet.zip', 'lava-149804-frames.zip',
        ])
        expect(exportFilename(recipe, 'spritesheet', false)).toBe('lava-149804-spritesheet.png')
        expect(sequenceFrameFilename(recipe, 0)).toBe('lava-149804-frames-0001.png')
        expect(new Set(formats.map(format => exportFilename(recipe, format))).size).toBe(formats.length)
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
        const stars = { seed: 17, density: 0.1, brightness: 1, starScale: 1, specialStarMix: 0.2 }
        const backdrop = { base: { kind: 'transparent' }, stars } as const
        const denser = { ...backdrop, stars: { ...stars, density: 0.2 } }
        const changed = { ...backdrop, stars: { ...stars, seed: 18 } }
        const low = (await createBackdropRasterizer(backdrop, 512, 512, frames)).renderBand(0, 512)
        const high = (await createBackdropRasterizer(denser, 512, 512, frames)).renderBand(0, 512)
        const other = (await createBackdropRasterizer(changed, 512, 512, frames)).renderBand(0, 512)
        const populated = (raster: Uint8ClampedArray): number[] => Array.from({ length: raster.length / 4 }, (_, index) => index)
            .filter(index => raster[index * 4 + 3]! > 0)

        expect((await createBackdropRasterizer(backdrop, 512, 512, frames)).renderBand(0, 512)).toEqual(low)
        expect(populated(high).length).toBeGreaterThan(populated(low).length)
        expect(populated(low).every(index => high[index * 4 + 3]! > 0)).toBe(true)
        expect(other).not.toEqual(low)

        // Stars on a solid matte: every pixel is opaque, and the stars change pixels the bare matte leaves black.
        const matte = { base: { kind: 'solid', color: '#102030' }, stars: null } as const
        const bare = (await createBackdropRasterizer(matte, 512, 512, frames)).renderBand(0, 512)
        const starry = (await createBackdropRasterizer({ ...matte, stars }, 512, 512, frames)).renderBand(0, 512)
        expect(Array.from({ length: 512 * 512 }, (_, index) => starry[index * 4 + 3]).every(alpha => alpha === 255)).toBe(true)
        expect(Array.from(bare.subarray(0, 4))).toEqual([16, 32, 48, 255])
        expect(starry).not.toEqual(bare)
    })
})
