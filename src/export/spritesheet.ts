import type { ExportRunOutput, ExportRunner } from './contract'
import {
    animatedFrameSize,
    canvasForSheet,
    createAnimatedSession,
    metadataBytes,
    pngBlob,
    spritesheetMetadata,
    throwIfAborted,
    uniquePhases,
    upscaleFrame,
    zip,
} from './animated'
import { effectiveChromaticAberration } from './effects'
import { exportFilename, exportStem } from './filenames'
import { createSpritesheetGrid } from './layout'

export const exportSpritesheet: ExportRunner = async (request, options): Promise<ExportRunOutput> => {
    if (request.format !== 'spritesheet') throw new Error(`Spritesheet export received ${request.format}.`)
    // Layout and metadata can reject the request, so they run before the session exists.
    const scale = request.recipe.export.scale
    const size = animatedFrameSize(request)
    const chromaticOffset = effectiveChromaticAberration(request.recipe, size)
    const metadata = spritesheetMetadata(request, size, size)
    const phases = uniquePhases(request)
    const grid = createSpritesheetGrid(phases.length, request.recipe.export.columns, size, size, request.recipe.export.margin)
    const { session, backdrop } = await createAnimatedSession(request, options)
    try {
        const sheet = canvasForSheet(grid.width, grid.height, null)
        const context = sheet.getContext('2d')
        if (!context) throw new Error('Canvas 2D is unavailable.')
        context.imageSmoothingEnabled = false
        for (let index = 0; index < grid.frames.length; index += 1) {
            throwIfAborted(options.signal)
            const frame = await session.renderFrame(phases[index]!, { requestId: request.id, signal: options.signal })
            const image = upscaleFrame(frame, scale, backdrop, chromaticOffset)
            const rect = grid.frames[index]!
            context.drawImage(image, rect.x, rect.y)
            options.onProgress?.({ requestId: request.id, stage: 'encode', completed: index + 1, total: grid.frames.length })
        }
        throwIfAborted(options.signal)
        const image = await pngBlob(sheet)
        const stem = exportStem(request.recipe, 'spritesheet')
        if (!request.includeMetadata) return {
            files: [{ filename: exportFilename(request.recipe, 'spritesheet', false), mediaType: 'image/png', data: image }],
            warnings: [],
        }
        const imageBytes = new Uint8Array(await image.arrayBuffer())
        return {
            files: [{ filename: exportFilename(request.recipe, 'spritesheet'), mediaType: 'application/zip', data: await zip({
                [`${stem}.png`]: imageBytes,
                [`${stem}.json`]: metadataBytes(metadata),
            }, options.signal) }],
            warnings: [],
        }
    } finally {
        session.dispose()
    }
}
