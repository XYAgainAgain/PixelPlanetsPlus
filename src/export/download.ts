import type { ExportFile } from './contract'

const DEFAULT_MAX_BLOB_BYTES = 512 * 1024 * 1024

interface SaveFilePickerOptions {
    suggestedName?: string
    types?: { description?: string, accept: Record<string, string[]> }[]
}

interface WritableFileStream {
    write: (data: Blob | Uint8Array) => Promise<void>
    close: () => Promise<void>
    abort: (reason?: unknown) => Promise<void>
}

interface FileHandle {
    createWritable: () => Promise<WritableFileStream>
}

export interface ExportSaveTarget {
    handle: FileHandle | null
}

type PickerWindow = Window & { showSaveFilePicker?: (options?: SaveFilePickerOptions) => Promise<FileHandle> }

export interface SaveExportOptions {
    signal?: AbortSignal
    maxBlobBytes?: number
}

export const acquireExportSaveTarget = async (
    filename: string,
    mediaType: string,
): Promise<ExportSaveTarget> => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
        throw new Error('Downloads require a browser DOM environment.')
    }
    const picker = (window as PickerWindow).showSaveFilePicker
    if (!picker) return { handle: null }
    return {
        handle: await picker({
            suggestedName: filename,
            types: [{ accept: { [mediaType]: [`.${filename.split('.').pop() ?? ''}`] } }],
        }),
    }
}

export const saveExportFile = async (
    file: ExportFile,
    options: SaveExportOptions = {},
    target: ExportSaveTarget = { handle: null },
): Promise<void> => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
        throw new Error('Downloads require a browser DOM environment.')
    }
    if (target.handle) {
        const writable = await target.handle.createWritable()
        try {
            const reader = file.data.stream().getReader()
            while (true) {
                if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('The save was canceled.', 'AbortError')
                const { done, value } = await reader.read()
                if (done) break
                await writable.write(value)
            }
            await writable.close()
        } catch (error) {
            await writable.abort(error)
            throw error
        }
        return
    }
    const limit = options.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES
    if (file.data.size > limit) {
        throw new RangeError('That export is too large for this browser to save directly. Try Chrome or Edge, or reduce the export size.')
    }
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('The save was canceled.', 'AbortError')
    const url = URL.createObjectURL(file.data)
    try {
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = file.filename
        anchor.rel = 'noopener'
        anchor.click()
    } finally {
        setTimeout(() => { URL.revokeObjectURL(url) }, 0)
    }
}
