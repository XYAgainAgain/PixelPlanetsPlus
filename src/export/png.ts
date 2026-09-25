import type { ExportRunOptions, ExportRunner } from './contract'
import { preflightRenderRequest, type PreflightLimits } from './preflight'
import { composeBand, encodePngBands, throwIfAborted } from './raster'
import { createExportSession } from './runtime'
import { createBackdropRasterizer } from './backdrop'
import { exportFilename } from './filenames'

export interface PngExportRunOptions extends ExportRunOptions {
    preflightLimits?: PreflightLimits
}

const runtimeLimits = (options: ExportRunOptions): PreflightLimits => {
    const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
    return {
        maxTextureDimension2D: options.gpu.current().textureLimit,
        maxWorkingBytes: deviceMemory ? deviceMemory * 1024 ** 3 * 0.25 : 512 * 1024 ** 2,
        maxBlobBytes: 512 * 1024 ** 2,
    }
}

export const assertPngAdmission = (request: Parameters<ExportRunner>[0], options: PngExportRunOptions): void => {
    const result = preflightRenderRequest(request, options.preflightLimits ?? runtimeLimits(options))
    if (!result.admitted) throw Object.assign(new RangeError(result.reasons[0]), { details: result.details })
}

export const exportCompositePng = async (
    request: Parameters<ExportRunner>[0],
    options: PngExportRunOptions,
): ReturnType<ExportRunner> => {
    if (request.format !== 'png') throw new Error(`exportCompositePng cannot run ${request.format} requests.`)
    throwIfAborted(options.signal)
    options.onProgress?.({ requestId: request.id, stage: 'preflight', completed: 0, total: 1 })
    assertPngAdmission(request, options)
    options.onProgress?.({ requestId: request.id, stage: 'preflight', completed: 1, total: 1 })
    const session = await createExportSession(request.recipe, options.gpu, { signal: options.signal })
    try {
        const body = await session.renderFrame(request.recipe.body.phase, {
            requestId: request.id,
            signal: options.signal,
            onProgress: options.onProgress,
        })
        throwIfAborted(options.signal)
        const backdrop = await createBackdropRasterizer(request.recipe.backdrop, request.recipe.canvas.width, request.recipe.canvas.height)
        const data = await encodePngBands({
            requestId: request.id,
            width: request.recipe.canvas.width,
            height: request.recipe.canvas.height,
            signal: options.signal,
            onProgress: options.onProgress,
            band: (startY, rowCount) => composeBand(request.recipe, body, startY, rowCount, 'composite', backdrop),
        })
        return {
            files: [{ filename: exportFilename(request.recipe, 'png'), mediaType: 'image/png', data }],
            warnings: [],
        }
    } finally {
        session.dispose()
    }
}
