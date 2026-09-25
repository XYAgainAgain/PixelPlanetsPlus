import type { WebGPURenderer } from 'three/webgpu'
import { createSerialQueue, type SerialQueue } from './export/serialQueue'

// No pixel planet needs more than 8192 px a side, and this keeps preflight identical on both backends.
export const TEXTURE_CEILING = 8192
// WebGL2's guaranteed minimum, used only when a backend exposes no readable limit at all.
const UNKNOWN_LIMIT = 2048

export type GpuBackend = 'webgpu' | 'webgl'

export const clampTextureLimit = (deviceLimit: unknown): number =>
    typeof deviceLimit === 'number' && Number.isFinite(deviceLimit) && deviceLimit >= 1
        ? Math.min(Math.floor(deviceLimit), TEXTURE_CEILING)
        : UNKNOWN_LIMIT

export const readTextureLimit = (renderer: WebGPURenderer): number => {
    try {
        const backend = renderer.backend as unknown as {
            device?: { limits?: { maxTextureDimension2D?: number } }
            gl?: WebGL2RenderingContext
        }
        const webGpuLimit = backend.device?.limits?.maxTextureDimension2D
        if (webGpuLimit !== undefined) return clampTextureLimit(webGpuLimit)
        if (backend.gl) return clampTextureLimit(Number(backend.gl.getParameter(backend.gl.MAX_TEXTURE_SIZE)))
    } catch {
        // Falls through to the guaranteed minimum.
    }
    return clampTextureLimit(undefined)
}

export class GpuLostError extends Error {
    constructor() {
        super('The graphics device was lost during the export. Try again once the planet is back on screen.')
        this.name = 'GpuLostError'
    }
}

/* One page-wide renderer per device generation. Consumers keep their own scenes and targets, take the
   queue for every render-plus-readback, and treat an aborted `lost` signal as a dead generation. */
export interface GpuContext {
    readonly renderer: WebGPURenderer
    readonly backend: GpuBackend
    readonly generation: number
    readonly queue: SerialQueue
    readonly lost: AbortSignal
    readonly textureLimit: number
}

export interface GpuHost {
    current: () => GpuContext
}

export const createGpuContext = (
    renderer: WebGPURenderer,
    backend: GpuBackend,
    generation: number,
): { context: GpuContext, markLost: () => void } => {
    const lost = new AbortController()
    return {
        context: {
            renderer,
            backend,
            generation,
            queue: createSerialQueue(),
            lost: lost.signal,
            textureLimit: readTextureLimit(renderer),
        },
        markLost: () => { lost.abort(new GpuLostError()) },
    }
}

/* Firefox before 155 hangs its GPU process when a WebGPU canvas reconfigures on resize (Bugzilla 2045240
   and 2060449); 155+ passed the resize stress matrix. ?backend= overrides everything for debugging. */
export const FIREFOX_WEBGPU_FLOOR = 155

export interface BackendRoute {
    backend: GpuBackend
    reason: string
}

export const routeBackend = (search: string, userAgent: string): BackendRoute => {
    const requested = new URLSearchParams(search).get('backend')
    if (requested === 'webgl') return { backend: 'webgl', reason: '?backend=webgl requested' }
    if (requested === 'webgpu') return { backend: 'webgpu', reason: '?backend=webgpu requested' }
    const firefox = /Firefox\/(\d+)/.exec(userAgent)
    if (firefox && Number(firefox[1]) < FIREFOX_WEBGPU_FLOOR) {
        return { backend: 'webgl', reason: `Firefox ${firefox[1]} predates the WebGPU resize fix in ${FIREFOX_WEBGPU_FLOOR}` }
    }
    return { backend: 'webgpu', reason: 'WebGPU preferred' }
}
