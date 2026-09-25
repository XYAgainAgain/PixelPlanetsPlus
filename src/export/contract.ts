import type { GpuBackend, GpuHost } from '../gpu'
import type { RenderProgress, RenderRequest } from './types'

export type ExportBackend = GpuBackend

export interface ExportRunOptions {
    gpu: GpuHost
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

// The full-canvas images every Scene Package holds before optional layer passes; preflight counts this list.
export const SCENE_PACKAGE_BASE_PASSES = [
    { name: 'composite.png', mode: 'composite' },
    { name: 'body.png', mode: 'body' },
    { name: 'background.png', mode: 'background' },
    { name: 'silhouette.png', mode: 'mask' },
] as const
