import type { describe as describeFunction, expect as expectFunction, it as itFunction } from 'vitest'

declare const describe: typeof describeFunction
declare const expect: typeof expectFunction
declare const it: typeof itFunction

import { decodeWorldParams, defaultPaletteFor, encodeWorldParams, worldParamsLength } from './worldParams'
import type { SceneRecipeV1 } from './types'

const defaultWorld = (): SceneRecipeV1 => ({
    schema: 'pixelplanetsplus-scene@1',
    celestialType: 'islands',
    canvas: { width: 1920, height: 1080 },
    body: { center: [0.5, 0.5], size: 1, phase: 0, rotation: 0, light: null },
    seed: 1,
    pixels: 100,
    palette: defaultPaletteFor('islands'),
    layers: [{ id: 'Water', visible: true }, { id: 'Land', visible: true }, { id: 'Cloud', visible: true }],
    dither: true,
    backdrop: { kind: 'stars', seed: 1, density: 1, brightness: 1, starScale: 1, specialStarMix: 0.5, gradientPhase: 0 },
    export: { scale: 1, frameCount: 60, columns: 8, margin: 0, startPhase: 0, endPhase: 1, direction: 'forward', framesPerSecond: 12 },
    effects: [],
})

describe('world parameter links', () => {
    it('omits every default world parameter', () => {
        const params = encodeWorldParams(defaultWorld())
        expect(params.toString()).toBe('')
        expect(worldParamsLength(defaultWorld())).toBe(0)
    })

    it('round-trips a typical customized world within the compact budget', () => {
        const recipe = defaultWorld()
        recipe.celestialType = 'lavaWorld'
        recipe.seed = 42
        recipe.pixels = 128
        recipe.body = { ...recipe.body, phase: 0.5 }
        recipe.palette = [['#8f4d57', '#52333f', '#3d2936', '#52333f', '#3d2936', '#ff8933', '#e64539', '#ad2f45']]
        recipe.layers = [{ id: 'Base', visible: true }, { id: 'Craters', visible: true }, { id: 'LavaRivers', visible: true }]
        recipe.backdrop = { kind: 'stars', seed: 42, density: 1, brightness: 1, starScale: 1, specialStarMix: 0.5, gradientPhase: 0 }
        const params = encodeWorldParams(recipe)
        expect(params.toString()).toBe('t=lava&s=42&p=128&r=.5')
        expect(worldParamsLength(recipe)).toBeLessThan(40)
        expect(decodeWorldParams(params)).toMatchObject({
            celestialType: 'lavaWorld', seed: 42, pixels: 128, body: { phase: 0.5, rotation: 0 },
        })
    })

    it('round-trips a custom palette and records its exact link length', () => {
        const recipe = defaultWorld()
        recipe.palette = [['#112233', '#445566', '#778899']]
        const query = encodeWorldParams(recipe).toString()
        expect(query).toBe('pal=ESIzRFVmd4iZ')
        expect(worldParamsLength(recipe)).toBe(query.length)
        expect(decodeWorldParams(new URLSearchParams(query)).palette?.[0]?.slice(0, 3)).toEqual(recipe.palette[0])
    })

    it('tolerates unknown, malformed, and missing world parameters', () => {
        const decoded = decodeWorldParams(new URLSearchParams('wat=nope&t=unknown&s=bad&p=99999&r=nope&ti=Infinity&d=maybe&l=-1&bg=oops&bs=bad&pal=%%%'))
        expect(decoded).toMatchObject({
            celestialType: 'islands', seed: 1, pixels: 100, dither: true,
            body: { phase: 0, rotation: 0 },
            backdrop: { kind: 'stars', seed: 1 },
        })
        expect(decoded.layers).toEqual(defaultWorld().layers)
        expect(decoded.palette).toEqual(defaultWorld().palette)
        expect(decodeWorldParams(new URLSearchParams()).seed).toBe(1)
    })

    it.each(['islands', 'gasGiant2'] as const)('restores the complete %s live palette', celestialType => {
        const decoded = decodeWorldParams(new URLSearchParams(`t=${celestialType === 'gasGiant2' ? 'ringed' : celestialType}`))
        expect(decoded.palette).toEqual(defaultPaletteFor(celestialType))
    })

    it('pads a short hand-written palette with safe built-in colors', () => {
        const decoded = decodeWorldParams(new URLSearchParams('t=ringed&pal=ESIz'))
        expect(decoded.palette?.[0]?.[0]).toBe('#112233')
        expect(decoded.palette?.[0]).toHaveLength(defaultPaletteFor('gasGiant2')[0]!.length)
        expect(decoded.palette?.[0]?.slice(1)).toEqual(defaultPaletteFor('gasGiant2')[0]!.slice(1))
    })

    it('rejects negative seeds consistently with scene recipes', () => {
        expect(decodeWorldParams(new URLSearchParams('s=-42')).seed).toBe(1)
    })
})
