import type { ExportRunOutput, ExportRunner } from './contract'
import {
    animatedFrameSize,
    createAnimatedSession,
    metadataBytes,
    playbackPhases,
    pngBlob,
    sequenceMetadata,
    throwIfAborted,
    upscaleFrame,
    zip,
} from './animated'
import { exportFilename, exportStem, sequenceFrameFilename } from './filenames'

export const exportPngSequence: ExportRunner = async (request, options): Promise<ExportRunOutput> => {
    if (request.format !== 'png-sequence') throw new Error(`PNG sequence export received ${request.format}.`)
    // Phases and metadata can reject the request, so they run before the session exists.
    const phases = playbackPhases(request)
    const scale = request.recipe.export.scale
    const size = animatedFrameSize(request)
    const metadata = sequenceMetadata(request, size, size, phases)
    const { session, backdrop } = await createAnimatedSession(request, options)
    const entries: Record<string, Uint8Array> = {}
    const stem = exportStem(request.recipe, 'png-sequence')
    try {
        for (let index = 0; index < phases.length; index += 1) {
            throwIfAborted(options.signal)
            const frame = await session.renderFrame(phases[index]!, { requestId: request.id, signal: options.signal })
            const png = await pngBlob(upscaleFrame(frame, scale, backdrop))
            entries[sequenceFrameFilename(request.recipe, index)] = new Uint8Array(await png.arrayBuffer())
            options.onProgress?.({ requestId: request.id, stage: 'encode', completed: index + 1, total: phases.length })
        }
        throwIfAborted(options.signal)
        entries[`${stem}.json`] = metadataBytes(metadata)
        return {
            files: [{ filename: exportFilename(request.recipe, 'png-sequence'), mediaType: 'application/zip', data: await zip(entries, options.signal) }],
            warnings: [],
        }
    } finally {
        session.dispose()
    }
}
