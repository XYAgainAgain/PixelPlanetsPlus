import { composerBodyToCanvasPixels } from './layout'
import type { ExportFrame } from './runtime'
import type { RenderProgress, SceneRecipeV1 } from './types'
import type { BackdropRasterizer } from './backdrop'

export const BAND_ROWS = 128

export const throwIfAborted = (signal?: AbortSignal): void => {
    if (signal?.aborted) throw signal.reason ?? new DOMException('The export was canceled.', 'AbortError')
}

const pngEncodingError = (details: string): Error => Object.assign(
    new Error('Something went wrong while saving the export.'),
    { cause: new Error(details), details },
)

const srgbToLinear = (value: number): number => {
    const normalized = value / 255
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
}

const linearToSrgb = (value: number): number => {
    const normalized = Math.max(0, Math.min(1, value))
    return Math.round(255 * (normalized <= 0.0031308 ? normalized * 12.92 : 1.055 * normalized ** (1 / 2.4) - 0.055))
}

export const composeBand = (
    recipe: SceneRecipeV1,
    body: ExportFrame | null,
    startY: number,
    rowCount: number,
    mode: 'composite' | 'body' | 'background' | 'mask',
    backdropRasterizer: BackdropRasterizer | null,
): Uint8ClampedArray => {
    const { width, height } = recipe.canvas
    const output = mode === 'body' || mode === 'mask'
        ? new Uint8ClampedArray(width * rowCount * 4)
        : backdropRasterizer?.renderBand(startY, rowCount)
            ?? new Uint8ClampedArray(width * rowCount * 4)
    if (mode === 'background' || !body) return output
    const placement = composerBodyToCanvasPixels(recipe.body, width, height)
    const left = Math.round(placement.center[0] - placement.size / 2)
    const top = Math.round(placement.center[1] - placement.size / 2)
    const size = Math.max(1, Math.round(placement.size))
    for (let localY = 0; localY < rowCount; localY += 1) {
        const canvasY = startY + localY
        const sourceY = Math.floor((canvasY - top) * body.height / size)
        if (sourceY < 0 || sourceY >= body.height) continue
        for (let canvasX = Math.max(0, left); canvasX < Math.min(width, left + size); canvasX += 1) {
            const sourceX = Math.floor((canvasX - left) * body.width / size)
            const sourceOffset = (sourceY * body.width + sourceX) * 4
            const targetOffset = (localY * width + canvasX) * 4
            const sourceAlpha = body.pixels[sourceOffset + 3]! / 255
            if (sourceAlpha === 0) continue
            if (mode === 'mask') {
                output[targetOffset] = 255
                output[targetOffset + 1] = 255
                output[targetOffset + 2] = 255
                output[targetOffset + 3] = body.pixels[sourceOffset + 3]!
                continue
            }
            const targetAlpha = output[targetOffset + 3]! / 255
            const alpha = sourceAlpha + targetAlpha * (1 - sourceAlpha)
            for (let channel = 0; channel < 3; channel += 1) {
                // Runtime readback is display-ready sRGB because LinearSRGBColorSpace is load-bearing there.
                const sourceLinear = srgbToLinear(body.pixels[sourceOffset + channel]!)
                const targetLinear = srgbToLinear(output[targetOffset + channel]!)
                const premultiplied = sourceLinear * sourceAlpha + targetLinear * targetAlpha * (1 - sourceAlpha)
                output[targetOffset + channel] = alpha === 0 ? 0 : linearToSrgb(premultiplied / alpha)
            }
            output[targetOffset + 3] = Math.round(alpha * 255)
        }
    }
    return output
}

interface EncodeOptions {
    requestId: string
    width: number
    height: number
    signal?: AbortSignal
    onProgress?: (progress: RenderProgress) => void
    band: (startY: number, rowCount: number) => Uint8ClampedArray
}

export const encodePngBands = async (options: EncodeOptions): Promise<Blob> => {
    throwIfAborted(options.signal)
    const worker = new Worker(new URL('./png.worker.ts', import.meta.url), { type: 'module' })
    const chunks: BlobPart[] = []
    let completed = 0
    let resolveEvent: (() => void) | null = null
    let rejectEvent: ((reason: unknown) => void) | null = null
    let done = false
    let pendingError: unknown = null
    const wait = (): Promise<void> => new Promise((resolve, reject) => {
        if (pendingError) {
            const error = pendingError
            pendingError = null
            reject(error)
            return
        }
        resolveEvent = resolve
        rejectEvent = reject
    })
    const settleResolve = (): void => {
        const resolve = resolveEvent
        resolveEvent = null
        rejectEvent = null
        resolve?.()
    }
    const settleReject = (error: unknown): void => {
        const reject = rejectEvent
        resolveEvent = null
        rejectEvent = null
        if (reject) reject(error)
        else pendingError = error
    }
    const abort = (): void => {
        worker.postMessage({ type: 'cancel' })
        settleReject(options.signal?.reason ?? new DOMException('The export was canceled.', 'AbortError'))
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    worker.addEventListener('message', (event: MessageEvent<{ type: string, chunk?: Uint8Array, message?: string, rows?: number }>) => {
        if (event.data.type === 'chunk' && event.data.chunk) chunks.push(event.data.chunk.slice().buffer as ArrayBuffer)
        else if (event.data.type === 'error') settleReject(pngEncodingError(event.data.message ?? 'PNG encoding failed.'))
        else if (event.data.type === 'done') {
            done = true
            settleResolve()
        } else if (event.data.type === 'ready' || event.data.type === 'progress') settleResolve()
    })
    worker.addEventListener('error', (event) => {
        const details = event.error instanceof Error ? `${event.error.name}: ${event.error.message}` : event.message
        settleReject(pngEncodingError(details))
    })
    try {
        worker.postMessage({ type: 'start', width: options.width, height: options.height })
        await wait()
        for (let startY = 0; startY < options.height; startY += BAND_ROWS) {
            throwIfAborted(options.signal)
            const rowCount = Math.min(BAND_ROWS, options.height - startY)
            const rows = options.band(startY, rowCount)
            worker.postMessage({ type: 'band', rows, rowCount }, [rows.buffer])
            await wait()
            completed += rowCount
            options.onProgress?.({ requestId: options.requestId, stage: 'encode', completed, total: options.height })
        }
        throwIfAborted(options.signal)
        worker.postMessage({ type: 'finish' })
        while (!done) await wait()
        throwIfAborted(options.signal)
        return new Blob(chunks, { type: 'image/png' })
    } finally {
        options.signal?.removeEventListener('abort', abort)
        worker.terminate()
    }
}
