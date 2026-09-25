import type { describe as describeFunction, expect as expectFunction, it as itFunction } from 'vitest'

declare const describe: typeof describeFunction
declare const expect: typeof expectFunction
declare const it: typeof itFunction
declare const vi: typeof import('vitest')['vi']
declare const afterEach: typeof import('vitest')['afterEach']

import { abortable, createSerialQueue, submitWhilePending } from './serialQueue'

const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

describe('export render queue', () => {
    it('runs holders one at a time in arrival order', async () => {
        const queue = createSerialQueue()
        const log: string[] = []
        const first = await queue.acquire()
        const second = queue.acquire().then((release) => { log.push('second'); return release })
        await tick()
        expect(log).toEqual([])
        first()
        ;(await second)()
        expect(log).toEqual(['second'])
    })

    it('rejects a canceled waiter at once but keeps later holders behind the running work', async () => {
        const queue = createSerialQueue()
        const running = await queue.acquire()
        const controller = new AbortController()
        const canceled = queue.acquire(controller.signal)
        let thirdAcquired = false
        const third = queue.acquire().then((release) => { thirdAcquired = true; return release })
        controller.abort(new DOMException('stop', 'AbortError'))
        await expect(canceled).rejects.toThrow('stop')
        await tick()
        expect(thirdAcquired).toBe(false)
        running()
        ;(await third)()
        expect(thirdAcquired).toBe(true)
    })

    it('reports idle only after in-flight work settles, so disposal can wait for it', async () => {
        const queue = createSerialQueue()
        const release = await queue.acquire()
        let idle = false
        void queue.idle().then(() => { idle = true })
        await tick()
        expect(idle).toBe(false)
        release()
        await tick()
        expect(idle).toBe(true)
    })

    it('reports busy synchronously while any slot is held or queued', async () => {
        const queue = createSerialQueue()
        expect(queue.busy()).toBe(false)
        const first = queue.acquire()
        expect(queue.busy()).toBe(true)
        const release = await first
        const controller = new AbortController()
        const waiter = queue.acquire(controller.signal)
        controller.abort(new DOMException('stop', 'AbortError'))
        await expect(waiter).rejects.toThrow('stop')
        // The canceled waiter's slot only frees once the work ahead of it does.
        expect(queue.busy()).toBe(true)
        release()
        release()
        await tick()
        expect(queue.busy()).toBe(false)
    })

    it('lets a caller stop waiting on work that keeps running', async () => {
        const controller = new AbortController()
        let finish!: () => void
        const work = new Promise<void>((resolve) => { finish = resolve })
        const waiting = abortable(work, controller.signal)
        controller.abort(new DOMException('gone', 'AbortError'))
        await expect(waiting).rejects.toThrow('gone')
        finish()
        await expect(work).resolves.toBeUndefined()
    })

    describe('readback submit nudges', () => {
        afterEach(() => { vi.useRealTimers() })
        const pendingPair = (): { pending: Promise<void>, settle: () => void } => {
            let settle!: () => void
            return { pending: new Promise<void>((resolve) => { settle = resolve }), settle }
        }

        it('submits until the readback settles, then stops', async () => {
            vi.useFakeTimers()
            let submits = 0
            const { pending, settle } = pendingPair()
            submitWhilePending(() => { submits += 1 }, pending, new AbortController().signal, 5)
            vi.advanceTimersByTime(50)
            expect(submits).toBe(10)
            settle()
            await vi.advanceTimersByTimeAsync(0)
            vi.advanceTimersByTime(100)
            expect(submits).toBe(10)
        })

        it('stops on device loss even if the readback never settles', () => {
            vi.useFakeTimers()
            let submits = 0
            const lost = new AbortController()
            submitWhilePending(() => { submits += 1 }, pendingPair().pending, lost.signal, 5)
            vi.advanceTimersByTime(20)
            lost.abort()
            vi.advanceTimersByTime(1000)
            expect(submits).toBe(4)
        })

        it('stops for good when submit throws, and never starts on an already lost device', () => {
            vi.useFakeTimers()
            let submits = 0
            submitWhilePending(() => { submits += 1; throw new Error('device gone') }, pendingPair().pending, new AbortController().signal, 5)
            vi.advanceTimersByTime(100)
            expect(submits).toBe(1)
            const lost = new AbortController()
            lost.abort()
            submitWhilePending(() => { submits += 1 }, pendingPair().pending, lost.signal, 5)
            vi.advanceTimersByTime(100)
            expect(submits).toBe(1)
        })
    })
})
