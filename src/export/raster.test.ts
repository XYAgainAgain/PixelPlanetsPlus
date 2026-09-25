import type { describe as describeFunction, expect as expectFunction, it as itFunction } from 'vitest'

declare const describe: typeof describeFunction
declare const expect: typeof expectFunction
declare const it: typeof itFunction

import { blendOver, composeBand } from './raster'
import type { BackdropRasterizer } from './backdrop'
import type { SceneRecipeV2 } from './types'

const recipe: SceneRecipeV2 = {
    schema: 'pixelplanetsplus-scene@2',
    celestialType: 'terranWet',
    canvas: { width: 16, height: 16 },
    body: { center: [0.5, 0.5], phase: 0, rotation: 0, light: null },
    seed: 3,
    pixels: 8,
    palette: [],
    layers: [],
    dither: true,
    backdrop: { base: { kind: 'transparent' }, stars: null },
    export: { scale: 2, frameCount: 1, columns: 1, margin: 0, startPhase: 0, endPhase: 1, direction: 'forward', framesPerSecond: 12 },
    effects: [],
}

// A deterministic pseudo-random backdrop with mixed opacity, so recombination is tested off the easy cases.
const backdrop: BackdropRasterizer = {
    renderBand: (startY, rowCount) => {
        const band = new Uint8ClampedArray(recipe.canvas.width * rowCount * 4)
        for (let index = 0; index < band.length; index += 1) {
            const y = startY + Math.floor(index / (recipe.canvas.width * 4))
            band[index] = (index * 37 + y * 101) % 256
        }
        return band
    },
}

// Straight-alpha body texels spanning halos (low alpha), edges, and opaque surface.
const body = {
    width: 8,
    height: 8,
    pixels: Uint8ClampedArray.from({ length: 8 * 8 * 4 }, (_, index) => (index * 53 + 17) % 256),
}

const straightOver = (top: ArrayLike<number>, bottom: ArrayLike<number>, offset: number): number[] => {
    const sourceAlpha = top[offset + 3]! / 255
    const targetAlpha = bottom[offset + 3]! / 255
    const alpha = sourceAlpha + targetAlpha * (1 - sourceAlpha)
    const rgb = [0, 1, 2].map((channel) => alpha === 0 ? 0
        : (top[offset + channel]! * sourceAlpha + bottom[offset + channel]! * targetAlpha * (1 - sourceAlpha)) / alpha)
    return [...rgb, alpha * 255]
}

describe('export compositing', () => {
    it('blends in display-encoded space the way the browser stacks the live canvases', () => {
        // Half-transparent white over opaque black: the screen shows 128, linear light would give 188.
        const target = new Uint8ClampedArray([0, 0, 0, 255])
        blendOver(target, 0, [255, 255, 255, 128], 0)
        expect(Array.from(target)).toEqual([128, 128, 128, 255])
    })

    it('leaves the target alone under a fully transparent texel and replaces it under an opaque one', () => {
        const target = new Uint8ClampedArray([10, 20, 30, 40])
        blendOver(target, 0, [200, 200, 200, 0], 0)
        expect(Array.from(target)).toEqual([10, 20, 30, 40])
        blendOver(target, 0, [1, 2, 3, 255], 0)
        expect(Array.from(target)).toEqual([1, 2, 3, 255])
    })

    it('recombines the Scene Package passes into its composite within one 8-bit step', () => {
        const rows = recipe.canvas.height
        const composite = composeBand(recipe, body, 0, rows, 'composite', backdrop)
        const bodyPass = composeBand(recipe, body, 0, rows, 'body', null)
        const background = composeBand(recipe, null, 0, rows, 'background', backdrop)
        let worst = 0
        for (let offset = 0; offset < composite.length; offset += 4) {
            const recombined = straightOver(bodyPass, background, offset)
            // Color is meaningless where the composite is fully transparent.
            const channels = composite[offset + 3] === 0 ? [3] : [0, 1, 2, 3]
            for (const channel of channels) worst = Math.max(worst, Math.abs(recombined[channel]! - composite[offset + channel]!))
        }
        expect(worst).toBeLessThanOrEqual(1)
    })
})
