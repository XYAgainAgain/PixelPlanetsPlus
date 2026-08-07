import type { ExportRunOutput, ExportRunner } from './contract'
import {
    canvasForSheet,
    createAnimatedSession,
    exportBaseName,
    metadataBytes,
    missingTextureLimitWarning,
    pngBlob,
    spritesheetMetadata,
    throwIfAborted,
    upscaleFrame,
    zip,
} from './animated'
import { createSpritesheetGrid } from './layout'

export const exportSpritesheet: ExportRunner = async (request, options): Promise<ExportRunOutput> => {
    if (request.format !== 'spritesheet') throw new Error(`Spritesheet export received ${request.format}.`)
    const { session, backdrop } = await createAnimatedSession(request, options)
    const scale = request.recipe.export.scale
    const frameWidth = session.width * scale
    const frameHeight = session.height * scale
    const metadata = spritesheetMetadata(request, frameWidth, frameHeight)
    const grid = createSpritesheetGrid(metadata.frames.length, request.recipe.export.columns,
        frameWidth, frameHeight, request.recipe.export.margin)
    try {
        const sheet = canvasForSheet(grid.width, grid.height, null)
        const context = sheet.getContext('2d')
        if (!context) throw new Error('Canvas 2D is unavailable.')
        context.imageSmoothingEnabled = false
        for (let index = 0; index < grid.frames.length; index += 1) {
            throwIfAborted(options.signal)
            const frame = await session.renderFrame(metadata.frames[index]!.phase, { requestId: request.id, signal: options.signal })
            const image = upscaleFrame(frame, scale, backdrop)
            const rect = grid.frames[index]!
            context.drawImage(image, rect.x, rect.y)
            options.onProgress?.({ requestId: request.id, stage: 'encode', completed: index + 1, total: grid.frames.length })
        }
        throwIfAborted(options.signal)
        const image = await pngBlob(sheet)
        const baseName = exportBaseName(request)
        if (!request.includeMetadata) return {
            files: [{ filename: `${baseName}.png`, mediaType: 'image/png', data: image }],
            warnings: missingTextureLimitWarning(options),
        }
        const imageBytes = new Uint8Array(await image.arrayBuffer())
        return {
            files: [{ filename: `${baseName}.zip`, mediaType: 'application/zip', data: await zip({
                [`${baseName}.png`]: imageBytes,
                [`${baseName}.json`]: metadataBytes(metadata),
            }, options.signal) }],
            warnings: missingTextureLimitWarning(options),
        }
    } finally {
        session.dispose()
    }
}
