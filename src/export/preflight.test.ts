import type { describe as describeFunction, expect as expectFunction, it as itFunction } from 'vitest'

declare const describe: typeof describeFunction
declare const expect: typeof expectFunction
declare const it: typeof itFunction

import { preflightRenderRequest } from './preflight'
import { SCENE_PACKAGE_BASE_PASSES } from './contract'
import { PLANETS } from '../tsl/values'
import type { RenderRequest, SceneRecipeV2 } from './types'

const request = (overrides: Partial<SceneRecipeV2['canvas'] & { pixels: number, frameCount: number, columns: number, margin: number }> = {}, format: RenderRequest['format'] = 'png'): RenderRequest => ({
    id: 'test',
    format,
    includeMetadata: true,
    includeLayers: false,
    recipe: {
        schema: 'pixelplanetsplus-scene@2',
        celestialType: 'terranWet',
        canvas: { width: overrides.width ?? 256, height: overrides.height ?? 256 },
        body: { center: [0.5, 0.5], phase: 0, rotation: 0, light: [0.2, 0.2] },
        seed: 1,
        pixels: overrides.pixels ?? 128,
        palette: [],
        layers: [],
        dither: true,
        backdrop: { base: { kind: 'transparent' }, stars: null },
        export: {
            scale: 1,
            frameCount: overrides.frameCount ?? 1,
            columns: overrides.columns ?? 1,
            margin: overrides.margin ?? 0,
            startPhase: 0,
            endPhase: 1,
            direction: 'forward',
            framesPerSecond: 12,
        },
        effects: [],
    },
})

describe('export preflight', () => {
    it('admits an obviously safe request', () => {
        expect(preflightRenderRequest(request(), { maxTextureDimension2D: 4096 }).admitted).toBe(true)
    })

    it('caps every edge at the 8192 ceiling even when the device reports more', () => {
        const result = preflightRenderRequest(request({ width: 8193 }), { maxTextureDimension2D: 16384 })
        expect(result.admitted).toBe(false)
        expect(result.reasons).toEqual(['That size is too big for this device. Try a smaller canvas or a lower scale.'])
        expect(result.details.join(' ')).toMatch(/Output width 8193px exceeds the export ceiling of 8192px/)
        expect(preflightRenderRequest(request({ width: 8192, height: 8192 }), { maxTextureDimension2D: 16384 }).admitted).toBe(true)
    })

    it('answers the same for a WebGPU default-limit device and a big WebGL2 device', () => {
        for (const width of [4096, 8192, 8193, 12000]) {
            const webGpu = preflightRenderRequest(request({ width }), { maxTextureDimension2D: 8192 })
            const webGl = preflightRenderRequest(request({ width }), { maxTextureDimension2D: 32768 })
            expect(webGl.admitted).toBe(webGpu.admitted)
            expect(webGl.details).toEqual(webGpu.details)
        }
    })

    it('still honors a device limit below the ceiling', () => {
        const result = preflightRenderRequest(request({ pixels: 2049 }), { maxTextureDimension2D: 2048 })
        expect(result.admitted).toBe(false)
        expect(result.reasons).toEqual(['That size is too big for this device. Try a smaller canvas or a lower scale.'])
        expect(result.details.join(' ')).toMatch(/Canonical render-target width 2049px exceeds the export ceiling of 2048px/)
    })

    it('holds spritesheets and animated frames to the same ceiling', () => {
        const sheet = preflightRenderRequest(request({ pixels: 1100, frameCount: 8, columns: 8 }, 'spritesheet'), { maxTextureDimension2D: 16384 })
        expect(sheet.admitted).toBe(false)
        expect(sheet.details.join(' ')).toMatch(/Output width 8800px exceeds the export ceiling of 8192px/)
    })

    it('keeps memory diagnostics out of the visitor-facing reason', () => {
        const result = preflightRenderRequest(request({ frameCount: 64 }, 'gif'), {
            maxTextureDimension2D: 4096,
            maxWorkingBytes: 1,
            maxBlobBytes: 1,
        })
        expect(result.reasons).toEqual([
            'That export needs more memory than this device has. Try a smaller canvas, fewer frames, or a lower scale.',
        ])
        expect(result.details).toHaveLength(2)
        expect(result.details.join(' ')).toMatch(/working memory.*Blob memory/)
    })

    it('estimates monotonically with canvas size and frame count', () => {
        const small = preflightRenderRequest(request({ width: 256, height: 256, frameCount: 2 }), { maxTextureDimension2D: 4096 }).estimate
        const large = preflightRenderRequest(request({ width: 512, height: 512, frameCount: 4 }), { maxTextureDimension2D: 4096 }).estimate
        const animatedSmall = preflightRenderRequest(request({ frameCount: 2 }, 'gif'), { maxTextureDimension2D: 4096 }).estimate
        const animatedLarge = preflightRenderRequest(request({ frameCount: 4 }, 'gif'), { maxTextureDimension2D: 4096 }).estimate
        expect(large.output.pixels).toBeGreaterThan(small.output.pixels)
        expect(animatedLarge.compressedOutputBytes).toBeGreaterThan(animatedSmall.compressedOutputBytes)
    })

    it('counts every Scene Package image the exporter writes, plus every possible layer pass', () => {
        const canvasBytes = 256 * 256 * 4
        const packaged = (includeLayers: boolean) => preflightRenderRequest(
            { ...request({}, 'scene-package'), includeLayers }, { maxTextureDimension2D: 4096 }).estimate
        // composite, body, background, and silhouette are always written before any optional layer pass.
        expect(SCENE_PACKAGE_BASE_PASSES.map((pass) => pass.name)).toEqual(['composite.png', 'body.png', 'background.png', 'silhouette.png'])
        expect(packaged(false).passBufferBytes).toBe(canvasBytes * 4)
        expect(packaged(true).passBufferBytes).toBe(canvasBytes * (4 + PLANETS.terranWet.layers.length))
    })

    it('counts every simultaneous GIF buffer, including the frozen backdrop and the transferred RGBA', () => {
        const transparent = request({ pixels: 100, frameCount: 4 }, 'gif')
        const starry: RenderRequest = {
            ...transparent,
            recipe: { ...transparent.recipe, backdrop: { base: { kind: 'solid', color: '#000000' }, stars: { seed: 1, density: 1, brightness: 1, starScale: 1, specialStarMix: 0.5 } } },
        }
        const frameBytes = 100 * 100 * 4
        const bare = preflightRenderRequest(transparent, { maxTextureDimension2D: 4096 }).estimate
        const withBackdrop = preflightRenderRequest(starry, { maxTextureDimension2D: 4096 }).estimate
        // Readback, straightened copy, and 2D source at canonical size; zoomed canvas; worker RGBA; indexed frame.
        expect(bare.encoderBytes).toBe(frameBytes * 3 + frameBytes + frameBytes + 100 * 100 + 4096 * 4 + 256 * 4 + 32_768 * 4)
        expect(withBackdrop.encoderBytes - bare.encoderBytes).toBe(frameBytes)
    })

    it('never mutates or reduces a blocked request', () => {
        const blocked = request({ pixels: 4097, frameCount: 64 }, 'gif')
        const before = structuredClone(blocked)
        const result = preflightRenderRequest(blocked, { maxTextureDimension2D: 4096 })
        expect(result.admitted).toBe(false)
        expect(blocked).toEqual(before)
        expect(result.estimate.frame.width).toBe(4097)
    })
})
