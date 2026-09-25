const abortReason = (signal: AbortSignal): unknown =>
    signal.reason ?? new DOMException('The export was canceled.', 'AbortError')

// Readback can wait on the GPU (WebGL polls its fence once per animation frame), so cancel must not wait for it.
export const abortable = <T>(work: Promise<T>, signal?: AbortSignal): Promise<T> => {
    if (!signal) return work
    return new Promise<T>((resolve, reject) => {
        const abort = (): void => { reject(abortReason(signal)) }
        if (signal.aborted) {
            abort()
            return
        }
        signal.addEventListener('abort', abort, { once: true })
        work.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort) })
    })
}

export interface SerialQueue {
    // Resolves with a release function once every earlier holder has released.
    acquire: (signal?: AbortSignal) => Promise<() => void>
    // Settles after everything queued so far has released, including holders whose callers gave up.
    idle: () => Promise<void>
    // True while anyone holds or waits for a slot; the live loop checks this synchronously and skips its frame.
    busy: () => boolean
}

export const createSerialQueue = (): SerialQueue => {
    let tail: Promise<void> = Promise.resolve()
    let outstanding = 0
    return {
        acquire: async (signal) => {
            const previous = tail
            let resolveHeld!: () => void
            const held = new Promise<void>((resolve) => { resolveHeld = resolve })
            let released = false
            const release = (): void => {
                if (released) return
                released = true
                outstanding -= 1
                resolveHeld()
            }
            outstanding += 1
            tail = previous.then(() => held)
            try {
                await abortable(previous, signal)
            } catch (error) {
                // Giving up while queued still hands the slot on in order, never ahead of earlier work.
                void previous.then(release)
                throw error
            }
            return release
        },
        idle: () => tail,
        busy: () => outstanding > 0,
    }
}

/* Calls submit on an interval until pending settles or lost aborts, and stops for good if submit throws.
   The caller's own cancel is deliberately not an input: the readback still has to finish and release the queue. */
export const submitWhilePending = (
    submit: () => void,
    pending: Promise<unknown>,
    lost: AbortSignal,
    interval: number,
): void => {
    if (lost.aborted) return
    const stop = (): void => {
        clearInterval(timer)
        lost.removeEventListener('abort', stop)
    }
    const timer = setInterval(() => {
        try {
            submit()
        } catch {
            stop()
        }
    }, interval)
    lost.addEventListener('abort', stop, { once: true })
    pending.then(stop, stop)
}
