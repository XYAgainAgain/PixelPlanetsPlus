import type { ExportRunOutput, ExportRunner } from './contract'
import {
    createAnimatedSession,
    exportBaseName,
    metadataBytes,
    missingTextureLimitWarning,
    playbackPhases,
    pngBlob,
    sequenceMetadata,
    throwIfAborted,
    upscaleFrame,
    zip,
} from './animated'

export const exportPngSequence: ExportRunner = async (request, options): Promise<ExportRunOutput> => {
    if (request.format !== 'png-sequence') throw new Error(`PNG sequence export received ${request.format}.`)
    const { session, backdrop } = await createAnimatedSession(request, options)
    const phases = playbackPhases(request)
    const scale = request.recipe.export.scale
    const metadata = sequenceMetadata(request, session.width * scale, session.height * scale, phases)
    const entries: Record<string, Uint8Array> = {}
    const baseName = exportBaseName(request)
    try {
        for (let index = 0; index < phases.length; index += 1) {
            throwIfAborted(options.signal)
            const frame = await session.renderFrame(phases[index]!, { requestId: request.id, signal: options.signal })
            const png = await pngBlob(upscaleFrame(frame, scale, backdrop))
            entries[`${baseName}-${String(index + 1).padStart(4, '0')}.png`] = new Uint8Array(await png.arrayBuffer())
            options.onProgress?.({ requestId: request.id, stage: 'encode', completed: index + 1, total: phases.length })
        }
        throwIfAborted(options.signal)
        entries[`${baseName}.json`] = metadataBytes(metadata)
        return {
            files: [{ filename: `${baseName}.zip`, mediaType: 'application/zip', data: await zip(entries, options.signal) }],
            warnings: missingTextureLimitWarning(options),
        }
    } finally {
        session.dispose()
    }
}
