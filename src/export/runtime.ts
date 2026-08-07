import {
    LinearSRGBColorSpace,
    Mesh,
    PerspectiveCamera,
    RenderTarget,
    Scene,
    Vector2,
    WebGPURenderer,
} from 'three/webgpu'
import { Color } from '../palette'
import { PLANET_FACTORIES, createPlanet, type PlanetRuntime } from '../tsl/registry'
import { PLANETS } from '../tsl/values'
import type { RenderProgress, SceneRecipeV1 } from './types'

export type ExportBackend = 'webgpu' | 'webgl'
export type RenderProgressListener = (progress: RenderProgress) => void

export const bodyLocalToLightUv = (local: readonly [number, number]): [number, number] =>
    [local[0] + 0.5, local[1] + 0.5]

export const lightUvToBodyLocal = (uv: readonly [number, number]): [number, number] =>
    [uv[0] - 0.5, uv[1] - 0.5]

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
    readonly recipe: SceneRecipeV1
    readonly backend: ExportBackend
    readonly width: number
    readonly height: number
    renderFrame: (phase: number, options: RenderFrameOptions) => Promise<ExportFrame>
    setIsolatedLayer: (layerId: string | null) => void
    visibleLayerIds: () => readonly string[]
    dispose: () => void
}

export interface CreateExportSessionOptions {
    signal?: AbortSignal
    canvas?: HTMLCanvasElement | OffscreenCanvas
}

export interface SharedRendererExportLease {
    readonly renderer: WebGPURenderer
    release: () => void
}

export interface SharedRendererExportLock {
    acquire: (signal?: AbortSignal) => Promise<SharedRendererExportLease>
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

const applyRecipe = (runtime: PlanetRuntime, recipe: SceneRecipeV1): void => {
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

const defaultCanvas = (): HTMLCanvasElement | OffscreenCanvas => {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(1, 1)
    if (typeof document !== 'undefined') return document.createElement('canvas')
    throw new Error('A canvas is required when no browser canvas implementation is available.')
}

export const createExportSession = async (
    recipe: SceneRecipeV1,
    backend: ExportBackend,
    options: CreateExportSessionOptions = {},
): Promise<ExportSession> => {
    throwIfAborted(options.signal)
    const planetName = PLANETS[recipe.celestialType].name
    const factory = PLANET_FACTORIES.find((entry) => entry.metadata.name === planetName)
    if (!factory) throw new Error(`unknown celestial body: ${recipe.celestialType}`)
    const width = Math.max(1, Math.round(recipe.pixels * factory.metadata.relativeScale))
    const height = width
    let runtime: PlanetRuntime | undefined
    let renderer: WebGPURenderer | undefined
    let target: RenderTarget | undefined

    try {
        runtime = createPlanet(planetName, recipe.seed)
        applyRecipe(runtime, recipe)

        const scene = new Scene()
        const camera = new PerspectiveCamera(75, 1, 0.1, 100000)
        camera.position.z = 1
        const largestLayer = Math.max(...runtime.metadata.layers.map((layer) => layer.quadScale))
        const cameraHeight = 2 * Math.tan((camera.fov * Math.PI) / 360)
        runtime.group.scale.setScalar(cameraHeight / largestLayer)
        scene.add(runtime.group)

        renderer = new WebGPURenderer({
            antialias: false,
            alpha: true,
            canvas: options.canvas ?? defaultCanvas(),
            forceWebGL: backend === 'webgl',
        })
        renderer.outputColorSpace = LinearSRGBColorSpace
        renderer.setPixelRatio(1)
        renderer.setSize(width, height, false)
        renderer.setClearColor(0x000000, 0)
        await renderer.init()
        throwIfAborted(options.signal)

        const actualBackend = renderer.backend as unknown as { isWebGPUBackend?: boolean, isWebGLBackend?: boolean }
        if (backend === 'webgpu' && !actualBackend.isWebGPUBackend) {
            throw exportRenderError('WebGPU export was requested, but Three initialized its WebGL fallback.')
        }
        if (backend === 'webgl' && !actualBackend.isWebGLBackend) {
            throw exportRenderError('WebGL export was requested, but Three did not initialize its WebGL backend.')
        }

        target = new RenderTarget(width, height, { depthBuffer: false, stencilBuffer: false })
        target.texture.colorSpace = LinearSRGBColorSpace
        let disposed = false

        const dispose = (): void => {
            if (disposed) return
            disposed = true
            target?.dispose()
            disposeRuntime(runtime!)
            renderer?.dispose()
            target = undefined
            runtime = undefined
            renderer = undefined
        }

        return {
            recipe,
            backend,
            width,
            height,
            setIsolatedLayer: (layerId) => {
                if (disposed) throw new Error('The export session has been disposed.')
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
                if (disposed) throw new Error('The export session has been disposed.')
                throwIfAborted(frameOptions.signal)
                frameOptions.onProgress?.({ requestId: frameOptions.requestId, stage: 'render', completed: 0, total: 1 })

                const activeRuntime = runtime!
                activeRuntime.rotation.value = 0
                activeRuntime.setExportPhase(phase)
                activeRuntime.rotation.value += recipe.body.rotation
                // Reapplied per frame: the preview session mutates recipe.body between renders.
                if (recipe.body.light && activeRuntime.lightOrigin) {
                    activeRuntime.lightOrigin.value.set(...bodyLocalToLightUv(recipe.body.light))
                }
                renderer!.setRenderTarget(target!)
                try {
                    renderer!.clear()
                    renderer!.render(scene, camera)
                } finally {
                    renderer!.setRenderTarget(null)
                }
                throwIfAborted(frameOptions.signal)

                const readback = await renderer!.readRenderTargetPixelsAsync(target!, 0, 0, width, height)
                throwIfAborted(frameOptions.signal)
                if (!(readback instanceof Uint8Array)) {
                    throw exportRenderError(`Expected RGBA8 readback, received ${readback.constructor.name}.`)
                }
                const pixels = straightenReadback(readback, width, height, backend === 'webgl')
                frameOptions.onProgress?.({ requestId: frameOptions.requestId, stage: 'render', completed: 1, total: 1 })
                return { width, height, pixels }
            },
            dispose,
        }
    } catch (error) {
        target?.dispose()
        if (runtime) disposeRuntime(runtime)
        renderer?.dispose()
        throw error
    }
}
