import type { describe as describeFunction, expect as expectFunction, it as itFunction } from 'vitest'

declare const describe: typeof describeFunction
declare const expect: typeof expectFunction
declare const it: typeof itFunction

import { distributeGifDelays, generatePhaseSamples, loopsSeamlessly } from './timing'

describe('export timing', () => {
    it('generates a forward full cycle without the loop-closing duplicate', () => {
        expect(generatePhaseSamples(0, 1, 4, 'forward')).toEqual([0, 0.25, 0.5, 0.75])
    })

    it('mirrors a forward full cycle in reverse', () => {
        expect(generatePhaseSamples(0, 1, 4, 'reverse')).toEqual([1, 0.75, 0.5, 0.25])
    })

    it('samples ping-pong turnaround endpoints once without a duplicated closing frame', () => {
        expect(generatePhaseSamples(0, 1, 6, 'ping-pong')).toEqual([0, 1 / 3, 2 / 3, 1, 2 / 3, 1 / 3])
    })

    it('rejects odd and too-small ping-pong frame counts', () => {
        expect(() => generatePhaseSamples(0, 1, 5, 'ping-pong')).toThrow('Ping-Pong requires an even frame count of at least 4.')
        expect(() => generatePhaseSamples(0, 1, 2, 'ping-pong')).toThrow('Ping-Pong requires an even frame count of at least 4.')
    })

    it('uses the requested endpoints for partial ranges', () => {
        expect(generatePhaseSamples(0.2, 0.6, 3, 'forward')).toEqual([0.2, 0.4, 0.6])
        expect(generatePhaseSamples(0.2, 0.6, 3, 'reverse')).toEqual([0.6, 0.4, 0.2])
    })

    it('marks only complete forward/reverse cycles and ping-pong as seamless', () => {
        expect(loopsSeamlessly(0, 1, 'forward')).toBe(true)
        expect(loopsSeamlessly(0, 1, 'reverse')).toBe(true)
        expect(loopsSeamlessly(0.2, 0.6, 'forward')).toBe(false)
        expect(loopsSeamlessly(0.2, 0.6, 'reverse')).toBe(false)
        expect(loopsSeamlessly(0.2, 0.6, 'ping-pong')).toBe(true)
    })

    it('distributes 12 FPS over 60 frames as exactly 500 centiseconds', () => {
        const delays = distributeGifDelays(12, 60)
        expect(delays).toHaveLength(60)
        expect(delays.reduce((sum, delay) => sum + delay, 0)).toBe(500)
    })

    it.each([
        [7, 13, 186],
        [24, 17, 71],
        [1, 1, 100],
    ])('preserves duration at awkward rate %d FPS and %d frames', (fps, frameCount, total) => {
        const delays = distributeGifDelays(fps, frameCount)
        expect(delays.reduce((sum, delay) => sum + delay, 0)).toBe(total)
    })

    it('returns deterministic delay distributions', () => {
        expect(distributeGifDelays(7, 13)).toEqual(distributeGifDelays(7, 13))
    })
})
