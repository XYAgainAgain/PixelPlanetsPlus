import type { RenderProgress, RenderRequest } from './types'

export type ExportBackend = 'webgpu' | 'webgl'

export interface ExportRunOptions {
    backend: ExportBackend
    signal?: AbortSignal
    onProgress?: (progress: RenderProgress) => void
}

export interface ExportFile {
    filename: string
    mediaType: string
    data: Blob
}

export interface ExportRunOutput {
    files: ExportFile[]
    warnings: string[]
}

// Every pipeline module (png, scene package, gif, spritesheet, sequence) conforms
// to this shape so the UI controller can dispatch formats without special cases.
export type ExportRunner = (request: RenderRequest, options: ExportRunOptions) => Promise<ExportRunOutput>
