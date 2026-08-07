import { strToU8, Zip, ZipPassThrough } from 'fflate'
import type { ExportRunner } from './contract'
import { assertPngAdmission } from './png'
import { composeBand, encodePngBands, throwIfAborted } from './raster'
import { createExportSession, type ExportFrame } from './runtime'
import { createBackdropRasterizer, type BackdropRasterizer } from './backdrop'
import type { AnimatedExportRunOptions } from './animated'

const safeName = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const FIXED_ZIP_DATE = new Date('2000-01-01T12:00:00.000Z')

interface PackageEntry {
    name: string
    data: Blob | Uint8Array
}

const createZipBlob = async (
    entries: readonly PackageEntry[],
    requestId: string,
    signal?: AbortSignal,
    onProgress?: Parameters<ExportRunner>[1]['onProgress'],
): Promise<Blob> => {
    const chunks: BlobPart[] = []
    let resolveZip: (() => void) | null = null
    let rejectZip: ((reason: unknown) => void) | null = null
    const completed = new Promise<void>((resolve, reject) => {
        resolveZip = resolve
        rejectZip = reject
    })
    const zip = new Zip((error, data, final) => {
        if (error) rejectZip?.(error)
        else {
            chunks.push(data)
            if (final) resolveZip?.()
        }
    })
    try {
        for (let index = 0; index < entries.length; index += 1) {
            throwIfAborted(signal)
            const entry = entries[index]!
            const file = new ZipPassThrough(entry.name)
            file.mtime = FIXED_ZIP_DATE
            zip.add(file)
            if (entry.data instanceof Blob) {
                const reader = entry.data.stream().getReader()
                while (true) {
                    throwIfAborted(signal)
                    const { done, value } = await reader.read()
                    if (done) break
                    file.push(value)
                }
                file.push(new Uint8Array(), true)
            } else {
                file.push(entry.data, true)
            }
            onProgress?.({ requestId, stage: 'package', completed: index + 1, total: entries.length })
        }
        throwIfAborted(signal)
        zip.end()
        await completed
        throwIfAborted(signal)
        return new Blob(chunks, { type: 'application/zip' })
    } catch (error) {
        zip.terminate()
        throw error
    }
}

const encodePass = async (
    request: Parameters<ExportRunner>[0],
    frame: ExportFrame | null,
    mode: 'composite' | 'body' | 'background' | 'mask',
    options: Parameters<ExportRunner>[1],
    backdrop: BackdropRasterizer | null,
): Promise<Blob> => {
    return encodePngBands({
        requestId: request.id,
        width: request.recipe.canvas.width,
        height: request.recipe.canvas.height,
        signal: options.signal,
        onProgress: options.onProgress,
        band: (startY, rowCount) => composeBand(request.recipe, frame, startY, rowCount, mode, backdrop),
    })
}

export const exportScenePackage: ExportRunner = async (request, options) => {
    if (request.format !== 'scene-package') throw new Error(`exportScenePackage cannot run ${request.format} requests.`)
    throwIfAborted(options.signal)
    options.onProgress?.({ requestId: request.id, stage: 'preflight', completed: 0, total: 1 })
    assertPngAdmission(request, options)
    options.onProgress?.({ requestId: request.id, stage: 'preflight', completed: 1, total: 1 })
    const session = await createExportSession(request.recipe, options.backend, { signal: options.signal })
    try {
        const frameOptions = { requestId: request.id, signal: options.signal, onProgress: options.onProgress }
        const body = await session.renderFrame(request.recipe.body.phase, frameOptions)
        throwIfAborted(options.signal)
        const backdrop = await createBackdropRasterizer(
            request.recipe.backdrop,
            request.recipe.canvas.width,
            request.recipe.canvas.height,
        )
        const entries: PackageEntry[] = [
            { name: 'composite.png', data: await encodePass(request, body, 'composite', options, backdrop) },
            { name: 'body.png', data: await encodePass(request, body, 'body', options, null) },
            { name: 'background.png', data: await encodePass(request, null, 'background', options, backdrop) },
            { name: 'silhouette.png', data: await encodePass(request, body, 'mask', options, null) },
            { name: 'scene.json', data: strToU8(JSON.stringify(request.recipe, null, 2)) },
        ]
        if (request.includeLayers) {
            for (const layerId of session.visibleLayerIds()) {
                throwIfAborted(options.signal)
                session.setIsolatedLayer(layerId)
                const layer = await session.renderFrame(request.recipe.body.phase, frameOptions)
                entries.push({ name: `layers/${safeName(layerId)}.png`, data: await encodePass(request, layer, 'body', options, null) })
            }
            session.setIsolatedLayer(null)
        }
        throwIfAborted(options.signal)
        const data = await createZipBlob(entries, request.id, options.signal, options.onProgress)
        return {
            files: [{ filename: `${request.recipe.celestialType}-${request.recipe.seed}-scene.zip`, mediaType: 'application/zip', data }],
            warnings: (options as AnimatedExportRunOptions).preflightLimits ? [] : ['This device limits exports to 2048 pixels per side.'],
        }
    } finally {
        session.dispose()
    }
}
