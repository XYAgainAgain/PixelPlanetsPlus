import type { describe as describeFunction, expect as expectFunction, it as itFunction } from 'vitest'

declare const describe: typeof describeFunction
declare const expect: typeof expectFunction
declare const it: typeof itFunction

import { bodyFrameCells, bodyFrameExtent, canonicalFrameSize } from './export/layout'
import { liveTargetSide } from './liveView'
import { PLANETS, type PlanetTypeId } from './tsl/values'

describe('live body target', () => {
    it('uses the export frame exactly for every type, so live and exported pixels line up', () => {
        for (const type of Object.keys(PLANETS) as PlanetTypeId[]) {
            for (const pixels of [12, 100, 137]) {
                expect(liveTargetSide(bodyFrameCells(PLANETS[type], pixels), 2048)).toBe(canonicalFrameSize(type, pixels))
            }
        }
    })

    it('frames at least every layer quad, one texel per art pixel', () => {
        for (const metadata of Object.values(PLANETS)) {
            const largest = Math.max(...metadata.layers.map((layer) => layer.quadScale))
            expect(bodyFrameExtent(metadata, 100)).toBeGreaterThanOrEqual(largest)
        }
    })

    it('caps at the live limit and never collapses below one texel', () => {
        expect(liveTargetSide(6144, 2048)).toBe(2048)
        expect(liveTargetSide(0, 2048)).toBe(1)
    })
})
