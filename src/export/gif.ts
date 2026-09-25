import type { ExportRunOutput, ExportRunner } from './contract'
import { animatedFrameSize, canvasPixels, createAnimatedSession, playbackPhases, throwIfAborted, upscaleFrame, type AnimatedExportRunOptions } from './animated'
import { effectiveChromaticAberration } from './effects'
import { exportFilename } from './filenames'
import { distributeGifDelays } from './timing'

type WorkerRequest =
    | { type: 'gif-start', width: number, height: number, transparent: boolean }
    | { type: 'gif-sample', rgba: Uint8ClampedArray }
    | { type: 'gif-palette' }
    | { type: 'gif-frame', rgba: Uint8ClampedArray, delay: number }
    | { type: 'gif-finish' }

type WorkerResponse =
    | { type: 'ready' }
    | { type: 'palette-ready' }
    | { type: 'frame-ready' }
    | { type: 'done', bytes: Uint8Array }
    | { type: 'error', message: string }

const workerMessage = (worker: Worker, message: WorkerRequest, transfer: Transferable[] = []): Promise<WorkerResponse> => new Promise((resolve, reject) => {
    const received = (event: MessageEvent<WorkerResponse>) => {
        cleanup()
        if (event.data.type === 'error') reject(new Error(event.data.message))
        else resolve(event.data)
    }
    const failed = (event: ErrorEvent) => {
        cleanup()
        reject(event.error ?? new Error(event.message))
    }
    const cleanup = (): void => {
        worker.removeEventListener('message', received)
        worker.removeEventListener('error', failed)
    }
    worker.addEventListener('message', received)
    worker.addEventListener('error', failed)
    worker.postMessage(message, transfer)
})

export const exportGif: ExportRunner = async (request, options): Promise<ExportRunOutput> => {
    if (request.format !== 'gif') throw new Error(`GIF export received ${request.format}.`)
    // Everything that can reject the request runs before the session or worker exist, so nothing leaks.
    const phases = playbackPhases(request)
    const delays = distributeGifDelays(request.recipe.export.framesPerSecond, phases.length)
    const scale = request.recipe.export.scale
    const size = animatedFrameSize(request)
    const chromaticOffset = effectiveChromaticAberration(request.recipe, size)
    const { session, backdrop } = await createAnimatedSession(request, options)
    let worker: Worker | null = null

    try {
        worker = new Worker(new URL('./encode.worker.ts', import.meta.url), { type: 'module' })
        await workerMessage(worker, {
            type: 'gif-start', width: size, height: size,
            transparent: request.recipe.backdrop.base.kind === 'transparent'
                && (options as AnimatedExportRunOptions).oneBitTransparency !== false,
        })
        for (let index = 0; index < phases.length; index += 1) {
            throwIfAborted(options.signal)
            const frame = await session.renderFrame(phases[index]!, { requestId: request.id, signal: options.signal })
            const rgba = canvasPixels(upscaleFrame(frame, scale, backdrop, chromaticOffset))
            await workerMessage(worker, { type: 'gif-sample', rgba }, [rgba.buffer])
            options.onProgress?.({ requestId: request.id, stage: 'palette', completed: index + 1, total: phases.length })
        }
        throwIfAborted(options.signal)
        await workerMessage(worker, { type: 'gif-palette' })
        for (let index = 0; index < phases.length; index += 1) {
            throwIfAborted(options.signal)
            const frame = await session.renderFrame(phases[index]!, { requestId: request.id, signal: options.signal })
            const rgba = canvasPixels(upscaleFrame(frame, scale, backdrop, chromaticOffset))
            await workerMessage(worker, { type: 'gif-frame', rgba, delay: delays[index]! }, [rgba.buffer])
            options.onProgress?.({ requestId: request.id, stage: 'encode', completed: index + 1, total: phases.length })
        }
        throwIfAborted(options.signal)
        const response = await workerMessage(worker, { type: 'gif-finish' })
        if (response.type !== 'done') throw new Error(`Unexpected GIF worker response: ${response.type}.`)
        const bytes = new Uint8Array(response.bytes.byteLength)
        bytes.set(response.bytes)
        return {
            files: [{ filename: exportFilename(request.recipe, 'gif'), mediaType: 'image/gif', data: new Blob([bytes.buffer], { type: 'image/gif' }) }],
            warnings: [],
        }
    } finally {
        worker?.terminate()
        session.dispose()
    }
}
