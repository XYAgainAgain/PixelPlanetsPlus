export interface Throttle {
    request: () => void
    cancel: () => void
}

/* Leading and trailing: the first request applies at once, bursts collapse to at most one apply per
   interval, and the trailing apply lands the settled state. apply always reads current state itself. */
export const createThrottle = (apply: () => void, interval: number, now: () => number = () => performance.now()): Throttle => {
    let last = Number.NEGATIVE_INFINITY
    let timer: ReturnType<typeof setTimeout> | null = null
    const run = (): void => {
        timer = null
        last = now()
        apply()
    }
    return {
        request: () => {
            if (timer !== null) return
            const wait = last + interval - now()
            if (wait <= 0) run()
            else timer = setTimeout(run, wait)
        },
        cancel: () => {
            if (timer !== null) clearTimeout(timer)
            timer = null
        },
    }
}
