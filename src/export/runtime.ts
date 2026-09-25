import {
    LinearSRGBColorSpace,
    Mesh,
    PerspectiveCamera,
    RenderTarget,
    Scene,
    Vector2,
    type WebGPURenderer,
} from 'three/webgpu'
import { GpuLostError, type GpuBackend, type GpuHost } from '../gpu'
import { Color } from '../palette'
import { PLANET_FACTORIES, createPlanet, type PlanetRuntime } from '../tsl/registry'
import { PLANETS } from '../tsl/values'
import { bodyFrameExtent, bodyLocalToLightUv, canonicalFrameSize } from './layout'
import { abortable, submitWhilePending } from './serialQueue'
import type { RenderProgress, SceneRecipeV2 } from './types'

export { bodyLocalToLightUv, lightUvToBodyLocal } from './layout'

export type ExportBackend = GpuBackend
export type RenderProgressListener = (progress: RenderProgress) => void

const exportRenderError = (details: string): Error => Object.assign(
    new Error('Something went wrong while rendering the export.'),
    { cause: new Error(details), details },
)

export interface ExportFrame {
    width: number
    height: number
    pixels: Uint8ClampedArray
}

export interface RenderFrameOptions {
    requestId: string
    signal?: AbortSignal
    onProgress?: RenderProgressListener
}

export interface ExportSession {
    readonly recipe: SceneRecipeV2
    readonly backend: ExportBackend
    readonly generation: number
    readonly width: number
    readonly height: number
    renderFrame: (phase: number, options: RenderFrameOptions) => Promise<ExportFrame>
    setIsolatedLayer: (layerId: string | null) => void
    visibleLayerIds: () => readonly string[]
    dispose: () => void
}

export interface CreateExportSessionOptions {
    signal?: AbortSignal
}

const throwIfAborted = (signal?: AbortSignal): void => {
    if (signal?.aborted) throw signal.reason ?? new DOMException('The export was canceled.', 'AbortError')
}

const disposeRuntime = (runtime: PlanetRuntime): void => {
    runtime.group.traverse((object) => {
        if (!(object instanceof Mesh)) return
        object.geometry.dispose()
        const materials = Array.isArray(object.material) ? object.material : [object.material]
        for (const material of materials) material.dispose()
    })
    runtime.group.removeFromParent()
}

const applyRecipe = (runtime: PlanetRuntime, recipe: SceneRecipeV2): void => {
    runtime.pixels.value = recipe.pixels
    runtime.rotation.value = recipe.body.rotation
    runtime.setDither(recipe.dither)
    runtime.palette.setColors(recipe.palette.flat().map(Color.fromHex))

    const layerIndices = new Map(runtime.metadata.layers.map((layer, index) => [layer.node, index]))
    for (const layer of recipe.layers) {
        const index = layerIndices.get(layer.id)
        if (index === undefined) throw new Error(`unknown ${runtime.metadata.name} layer: ${layer.id}`)
        runtime.setLayerVisible(index, layer.visible)
    }

    if (recipe.body.light && runtime.lightOrigin) {
        runtime.lightOrigin.value.copy(new Vector2(...bodyLocalToLightUv(recipe.body.light)))
    }
}

const straightenReadback = (
    source: Uint8Array,
    width: number,
    height: number,
    flipY: boolean,
): Uint8ClampedArray => {
    const rowBytes = width * 4
    // WebGPU readbacks can pad each row to its required 256-byte alignment.
    const rowStride = height > 1 ? (source.byteLength - rowBytes) / (height - 1) : rowBytes
    if (!Number.isInteger(rowStride) || rowStride < rowBytes) {
        throw exportRenderError(`Invalid RGBA8 readback layout: ${source.byteLength} bytes for ${width}x${height}.`)
    }
    const output = new Uint8ClampedArray(rowBytes * height)
    for (let sourceY = 0; sourceY < height; sourceY += 1) {
        const targetY = flipY ? height - sourceY - 1 : sourceY
        for (let x = 0; x < rowBytes; x += 4) {
            const sourceOffset = sourceY * rowStride + x
            const targetOffset = targetY * rowBytes + x
            const alpha = source[sourceOffset + 3]!
            output[targetOffset + 3] = alpha
            if (alpha === 0) continue
            // Render-target readback is premultiplied, so recover display-ready RGB before composition.
            const scale = 255 / alpha
            output[targetOffset] = Math.round(source[sourceOffset]! * scale)
            output[targetOffset + 1] = Math.round(source[sourceOffset + 1]! * scale)
            output[targetOffset + 2] = Math.round(source[sourceOffset + 2]! * scale)
        }
    }
    return output
}

/* Firefox only notices finished GPU work on a 100 ms timer unless something is submitted (Bugzilla 1870699),
   and the live loop is frozen during exports, so empty submits keep readbacks from idling on that timer. */
const nudgeWhilePending = (renderer: WebGPURenderer, pending: Promise<unknown>, lost: AbortSignal): void => {
    const device = (renderer.backend as unknown as { device?: { queue: { submit: (buffers: []) => void } } }).device
    if (device) submitWhilePending(() => { device.queue.submit([]) }, pending, lost, 5)
}

export const createExportSession = async (
    recipe: SceneRecipeV2,
    gpu: GpuHost,
    options: CreateExportSessionOptions = {},
): Promise<ExportSession> => {
    throwIfAborted(options.signal)
    const planetName = PLANETS[recipe.celestialType].name
    const factory = PLANET_FACTORIES.find((entry) => entry.metadata.name === planetName)
    if (!factory) throw new Error(`unknown celestial body: ${recipe.celestialType}`)
    // Bound to one device generation: after a loss its GPU resources are gone, so it fails instead of limping on.
    const context = gpu.current()
    throwIfAborted(context.lost)
    const width = canonicalFrameSize(recipe.celestialType, recipe.pixels)
    const height = width
    let runtime: PlanetRuntime | undefined
    let target: RenderTarget | undefined

    try {
        runtime = createPlanet(planetName, recipe.seed)
        applyRecipe(runtime, recipe)

        const scene = new Scene()
        const camera = new PerspectiveCamera(75, 1, 0.1, 100000)
        camera.position.z = 1
        const cameraHeight = 2 * Math.tan((camera.fov * Math.PI) / 360)
        runtime.group.scale.setScalar(cameraHeight / bodyFrameExtent(runtime.metadata, recipe.pixels))
        scene.add(runtime.group)

        target = new RenderTarget(width, height, { depthBuffer: false, stencilBuffer: false })
        target.texture.colorSpace = LinearSRGBColorSpace
        let disposed = false
        let disposeRequested = false
        const disposedError = (): Error => new Error('The export session has been disposed.')
        const lostError = (): unknown => context.lost.reason ?? new GpuLostError()

        // Frees only what this session owns; the shared renderer outlives every export.
        const destroy = (): void => {
            if (disposed) return
            disposed = true
            target?.dispose()
            disposeRuntime(runtime!)
            target = undefined
            runtime = undefined
        }

        // Deferred while live: three's readback keeps using the target after a canceled caller stops waiting.
        const dispose = (): void => {
            if (disposeRequested) return
            disposeRequested = true
            if (context.lost.aborted) destroy()
            else void context.queue.idle().then(destroy)
        }

        return {
            recipe,
            backend: context.backend,
            generation: context.generation,
            width,
            height,
            setIsolatedLayer: (layerId) => {
                if (disposeRequested) throw disposedError()
                const index = layerId === null
                    ? -1
                    : runtime!.metadata.layers.findIndex((layer) => layer.node === layerId)
                if (layerId !== null && index < 0) throw new Error(`unknown ${runtime!.metadata.name} layer: ${layerId}`)
                runtime!.group.children.forEach((child, childIndex) => {
                    const configured = recipe.layers.find((layer) => layer.id === runtime!.metadata.layers[childIndex]?.node)
                    child.visible = configured?.visible === true && (layerId === null || childIndex === index)
                })
            },
            visibleLayerIds: () => runtime!.metadata.layers
                .filter((layer, index) => recipe.layers.find((entry) => entry.id === layer.node)?.visible === true
                    && runtime!.group.children[index] !== undefined)
                .map((layer) => layer.node),
            renderFrame: async (phase, frameOptions) => {
                if (disposeRequested) throw disposedError()
                throwIfAborted(frameOptions.signal)
                if (context.lost.aborted || gpu.current() !== context) throw lostError()
                const release = await abortable(context.queue.acquire(frameOptions.signal), context.lost)
                let readbackWork: Promise<unknown> | null = null
                try {
                    if (disposeRequested) throw disposedError()
                    throwIfAborted(frameOptions.signal)
                    throwIfAborted(context.lost)
                    frameOptions.onProgress?.({ requestId: frameOptions.requestId, stage: 'render', completed: 0, total: 1 })

                    const activeRuntime = runtime!
                    activeRuntime.rotation.value = 0
                    activeRuntime.setExportPhase(phase)
                    activeRuntime.rotation.value += recipe.body.rotation
                    // Reapplied per frame: the preview session mutates recipe.body between renders.
                    if (recipe.body.light && activeRuntime.lightOrigin) {
                        activeRuntime.lightOrigin.value.set(...bodyLocalToLightUv(recipe.body.light))
                    }
                    const { renderer } = context
                    // Each pass sets its own state; the live loop skips its frames while this slot is held.
                    renderer.setClearColor(0x000000, 0)
                    renderer.setRenderTarget(target!)
                    try {
                        renderer.clear()
                        renderer.render(scene, camera)
                    } finally {
                        renderer.setRenderTarget(null)
                    }
                    const pending = renderer.readRenderTargetPixelsAsync(target!, 0, 0, width, height)
                    readbackWork = pending
                    void pending.then(release, release)
                    nudgeWhilePending(renderer, pending, context.lost)
                    const readback = await abortable(abortable(pending, frameOptions.signal), context.lost)
                    throwIfAborted(frameOptions.signal)
                    if (!(readback instanceof Uint8Array)) {
                        throw exportRenderError(`Expected RGBA8 readback, received ${readback.constructor.name}.`)
                    }
                    const pixels = straightenReadback(readback, width, height, context.backend === 'webgl')
                    frameOptions.onProgress?.({ requestId: frameOptions.requestId, stage: 'render', completed: 1, total: 1 })
                    return { width, height, pixels }
                } finally {
                    if (!readbackWork) release()
                }
            },
            dispose,
        }
    } catch (error) {
        target?.dispose()
        if (runtime) disposeRuntime(runtime)
        throw error
    }
}
