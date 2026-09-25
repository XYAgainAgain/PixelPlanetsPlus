import type { afterEach as afterEachFunction, describe as describeFunction, expect as expectFunction, it as itFunction, vi as viObject } from 'vitest'

declare const afterEach: typeof afterEachFunction
declare const describe: typeof describeFunction
declare const expect: typeof expectFunction
declare const it: typeof itFunction
declare const vi: typeof viObject

import { createThrottle } from './throttle'

describe('resize throttle', () => {
    afterEach(() => { vi.useRealTimers() })

    it('applies the first request at once, then at most once per interval, then once on settle', () => {
        vi.useFakeTimers()
        let applied = 0
        const throttle = createThrottle(() => { applied += 1 }, 150, () => Date.now())
        // A continuous drag: one request per 16 ms frame for one second.
        for (let frame = 0; frame < 63; frame += 1) {
            throttle.request()
            vi.advanceTimersByTime(16)
        }
        const duringDrag = applied
        vi.advanceTimersByTime(1000)
        expect(duringDrag).toBeLessThanOrEqual(8)
        expect(applied).toBe(duringDrag + 1)
    })

    it('never applies after cancel', () => {
        vi.useFakeTimers()
        let applied = 0
        const throttle = createThrottle(() => { applied += 1 }, 150, () => Date.now())
        throttle.request()
        throttle.request()
        throttle.cancel()
        vi.advanceTimersByTime(500)
        expect(applied).toBe(1)
    })
})
