import type { describe as describeFunction, expect as expectFunction, it as itFunction } from 'vitest'

declare const describe: typeof describeFunction
declare const expect: typeof expectFunction
declare const it: typeof itFunction

import { preflightRenderRequest } from './preflight'
import type { RenderRequest, SceneRecipeV1 } from './types'

const request = (overrides: Partial<SceneRecipeV1['canvas'] & { pixels: number, frameCount: number, columns: number, margin: number }> = {}, format: RenderRequest['format'] = 'png'): RenderRequest => ({
    id: 'test',
    format,
    includeMetadata: true,
    includeLayers: false,
    recipe: {
        schema: 'pixelplanetsplus-scene@1',
        celestialType: 'terranWet',
        canvas: { width: overrides.width ?? 256, height: overrides.height ?? 256 },
        body: { center: [0.5, 0.5], size: 1, phase: 0, rotation: 0, light: [0.2, 0.2] },
        seed: 1,
        pixels: overrides.pixels ?? 128,
        palette: [],
        layers: [],
        dither: true,
        backdrop: { kind: 'transparent' },
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

    it('blocks an output dimension over the format ceiling with the limiting dimension', () => {
        const result = preflightRenderRequest(request({ width: 32769 }), { maxTextureDimension2D: 65536 })
        expect(result.admitted).toBe(false)
        expect(result.reasons).toEqual(['That size is too big for this device. Try a smaller canvas or a lower scale.'])
        expect(result.details.join(' ')).toMatch(/Output width 32769px.*format ceiling/)
    })

    it('blocks output pixel count over the format ceiling', () => {
        const result = preflightRenderRequest(request({ width: 16384, height: 16385 }), { maxTextureDimension2D: 65536 })
        expect(result.admitted).toBe(false)
        expect(result.reasons).toEqual(['That size is too big for this device. Try a smaller canvas or a lower scale.'])
        expect(result.details.join(' ')).toMatch(/Output area .*exceeds the format ceiling/)
    })

    it('names the resource when a texture limit is exceeded', () => {
        const result = preflightRenderRequest(request({ pixels: 2049 }), { maxTextureDimension2D: 2048 })
        expect(result.admitted).toBe(false)
        expect(result.reasons).toEqual(['That size is too big for this device. Try a smaller canvas or a lower scale.'])
        expect(result.details.join(' ')).toMatch(/Canonical render-target width .*texture\/render-target limit/)
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

    it('never mutates or reduces a blocked request', () => {
        const blocked = request({ pixels: 4097, frameCount: 64 }, 'gif')
        const before = structuredClone(blocked)
        const result = preflightRenderRequest(blocked, { maxTextureDimension2D: 4096 })
        expect(result.admitted).toBe(false)
        expect(blocked).toEqual(before)
        expect(result.estimate.frame.width).toBe(4097)
    })
})
