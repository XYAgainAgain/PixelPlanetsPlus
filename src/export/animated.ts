import { zip as createZip, strToU8, type AsyncZippable } from 'fflate'
import { createSpritesheetGrid } from './layout'
import { preflightRenderRequest, type PreflightLimits } from './preflight'
import { createExportSession, type ExportFrame } from './runtime'
import { generatePhaseSamples } from './timing'
import { createBackdropRasterizer } from './backdrop'
import type { ExportRunOptions } from './contract'
import type { RenderRequest, SequenceMetadataV1, SpritesheetMetadataV1 } from './types'

const DEFAULT_WORKING_LIMIT = 512 * 1024 * 1024
const DEFAULT_BLOB_LIMIT = 512 * 1024 * 1024
const CONSERVATIVE_TEXTURE_LIMIT = 2048
const FIXED_ZIP_DATE = new Date('2000-01-01T12:00:00.000Z')

export interface AnimatedExportRunOptions extends ExportRunOptions {
    preflightLimits?: PreflightLimits
    oneBitTransparency?: boolean
}

export const throwIfAborted = (signal?: AbortSignal): void => {
    if (signal?.aborted) throw signal.reason ?? new DOMException('The export was canceled.', 'AbortError')
}

const runtimeLimits = (): PreflightLimits => {
    const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
    return {
        maxTextureDimension2D: CONSERVATIVE_TEXTURE_LIMIT,
        maxWorkingBytes: deviceMemory ? deviceMemory * 1024 ** 3 * 0.25 : DEFAULT_WORKING_LIMIT,
        maxBlobBytes: DEFAULT_BLOB_LIMIT,
    }
}

export const preflightAnimatedExport = (request: RenderRequest, options: AnimatedExportRunOptions): void => {
    const frameCount = request.format === 'spritesheet' ? uniquePhases(request).length : playbackPhases(request).length
    const admissionRequest = frameCount === request.recipe.export.frameCount ? request : {
        ...request,
        recipe: { ...request.recipe, export: { ...request.recipe.export, frameCount } },
    }
    const result = preflightRenderRequest(admissionRequest, options.preflightLimits ?? runtimeLimits())
    if (!result.admitted) throw Object.assign(new RangeError(result.reasons[0]), { details: result.details })
}

export const playbackPhases = (request: RenderRequest): number[] => generatePhaseSamples(
        request.recipe.export.startPhase,
        request.recipe.export.endPhase,
        request.recipe.export.frameCount,
        request.recipe.export.direction,
    )

export const uniquePhases = (request: RenderRequest): number[] => {
    const phases = playbackPhases(request)
    return request.recipe.export.direction === 'ping-pong'
        ? phases.slice(0, Math.floor(phases.length / 2) + 1)
        : phases
}

type Canvas = OffscreenCanvas | HTMLCanvasElement

const createCanvas = (width: number, height: number): Canvas => {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height)
    if (typeof document !== 'undefined') {
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        return canvas
    }
    throw new Error('Canvas 2D is unavailable.')
}

const context = (canvas: Canvas): OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D => {
    const value = canvas.getContext('2d')
    if (!value) throw new Error('Canvas 2D is unavailable.')
    value.imageSmoothingEnabled = false
    return value
}

export const pngBlob = async (canvas: Canvas): Promise<Blob> => {
    if ('convertToBlob' in canvas) return canvas.convertToBlob({ type: 'image/png' })
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PNG encoding failed.')), 'image/png')
    })
}

const frozenBackdrop = async (request: RenderRequest, width: number, height: number): Promise<Canvas | null> => {
    const backdrop = request.recipe.backdrop
    if (backdrop.kind === 'transparent') return null
    const canvas = createCanvas(width, height)
    const pixels = (await createBackdropRasterizer(backdrop, width, height)).renderBand(0, height)
    context(canvas).putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0)
    return canvas
}

export const upscaleFrame = (
    frame: ExportFrame,
    scale: number,
    backdrop: Canvas | null,
): Canvas => {
    const output = createCanvas(frame.width * scale, frame.height * scale)
    const outputContext = context(output)
    if (backdrop) outputContext.drawImage(backdrop, 0, 0, output.width, output.height)
    const source = createCanvas(frame.width, frame.height)
    context(source).putImageData(new ImageData(new Uint8ClampedArray(frame.pixels), frame.width, frame.height), 0, 0)
    outputContext.drawImage(source, 0, 0, output.width, output.height)
    return output
}

export const canvasPixels = (canvas: Canvas): Uint8ClampedArray =>
    context(canvas).getImageData(0, 0, canvas.width, canvas.height).data

export const createAnimatedSession = async (request: RenderRequest, options: AnimatedExportRunOptions) => {
    options.onProgress?.({ requestId: request.id, stage: 'preflight', completed: 0, total: 1 })
    preflightAnimatedExport(request, options)
    options.onProgress?.({ requestId: request.id, stage: 'preflight', completed: 1, total: 1 })
    throwIfAborted(options.signal)
    const session = await createExportSession(request.recipe, options.backend, { signal: options.signal })
    try {
        const backdrop = await frozenBackdrop(request, session.width * request.recipe.export.scale, session.height * request.recipe.export.scale)
        return { session, backdrop }
    } catch (error) {
        session.dispose()
        throw error
    }
}

export const spritesheetMetadata = (
    request: RenderRequest,
    width: number,
    height: number,
): SpritesheetMetadataV1 => {
    const { export: settings } = request.recipe
    const phases = uniquePhases(request)
    const grid = createSpritesheetGrid(phases.length, settings.columns, width, height, settings.margin)
    const order = playbackPhases(request).map((phase) => phases.indexOf(phase))
    const duration = 1000 / settings.framesPerSecond
    return {
        schema: 'pixelplanetsplus-spritesheet@1',
        celestialType: request.recipe.celestialType,
        image: { width: grid.width, height: grid.height },
        frame: { width, height, margin: settings.margin },
        grid: { columns: grid.columns, rows: grid.rows, order: 'left-to-right-top-to-bottom' },
        playback: { direction: settings.direction, loop: true, framesPerSecond: settings.framesPerSecond, order },
        scale: settings.scale,
        transparent: request.recipe.backdrop.kind === 'transparent',
        backdrop: request.recipe.backdrop.kind,
        frames: grid.frames.map((frame, index) => ({ ...frame, phase: phases[index]!, durationMilliseconds: duration })),
    }
}

export const sequenceMetadata = (
    request: RenderRequest,
    width: number,
    height: number,
    phases: readonly number[],
): SequenceMetadataV1 => {
    const baseName = exportBaseName(request)
    return {
        schema: 'pixelplanetsplus-sequence@1',
        celestialType: request.recipe.celestialType,
        frame: { width, height },
        playback: { direction: request.recipe.export.direction, loop: true, framesPerSecond: request.recipe.export.framesPerSecond },
        scale: request.recipe.export.scale,
        transparent: request.recipe.backdrop.kind === 'transparent',
        backdrop: request.recipe.backdrop.kind,
        frames: phases.map((phase, index) => ({
            index,
            filename: `${baseName}-${String(index + 1).padStart(4, '0')}.png`,
            phase,
            durationMilliseconds: 1000 / request.recipe.export.framesPerSecond,
        })),
    }
}

export const zip = (entries: Record<string, Uint8Array>, signal?: AbortSignal): Promise<Blob> => new Promise((resolve, reject) => {
    throwIfAborted(signal)
    const deterministicEntries: AsyncZippable = {}
    for (const [name, data] of Object.entries(entries)) deterministicEntries[name] = [data, { mtime: FIXED_ZIP_DATE }]
    const archive = createZip(deterministicEntries, (error, data) => {
        if (error) {
            cleanup()
            reject(error)
            return
        }
        const copy = new Uint8Array(data.byteLength)
        copy.set(data)
        cleanup()
        resolve(new Blob([copy.buffer], { type: 'application/zip' }))
    })
    const abort = (): void => {
        archive()
        cleanup()
        reject(signal?.reason ?? new DOMException('The export was canceled.', 'AbortError'))
    }
    const cleanup = (): void => { signal?.removeEventListener('abort', abort) }
    signal?.addEventListener('abort', abort, { once: true })
})

export const metadataBytes = (metadata: SpritesheetMetadataV1 | SequenceMetadataV1): Uint8Array =>
    strToU8(`${JSON.stringify(metadata, null, 2)}\n`)

export const canvasForSheet = (width: number, height: number, backdrop: Canvas | null): Canvas => {
    const canvas = createCanvas(width, height)
    if (backdrop) context(canvas).drawImage(backdrop, 0, 0, width, height)
    return canvas
}

export const exportBaseName = (request: RenderRequest): string => `${request.recipe.celestialType}-${request.recipe.seed}`

export const missingTextureLimitWarning = (options: AnimatedExportRunOptions): string[] => options.preflightLimits
    ? []
    : [`This device limits exports to ${CONSERVATIVE_TEXTURE_LIMIT} pixels per side.`]
