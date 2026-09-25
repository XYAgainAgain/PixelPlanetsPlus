import {
    LinearSRGBColorSpace,
    Mesh,
    MeshBasicNodeMaterial,
    NearestFilter,
    NoBlending,
    PerspectiveCamera,
    PlaneGeometry,
    RenderTarget,
    Scene,
    type WebGPURenderer,
} from 'three/webgpu'
import { texture, uv } from 'three/tsl'
import { bodyFrameCells, bodyFrameExtent } from './export/layout'
import type { PlanetRuntime } from './tsl/registry'

/* The body renders into its own square target at its art grid, exactly like an export frame, and a nearest
   quad places it on the stage: Pixels never resizes the canvas, and live dither matches exported dither. */
export interface LiveView {
    readonly scene: Scene
    readonly camera: PerspectiveCamera
    // Frames the planet like the export runtime does and sizes the target to its pixel grid.
    syncBody: (planet: PlanetRuntime, framing: number, maxSide: number) => void
    render: (renderer: WebGPURenderer) => void
    compile: (renderer: WebGPURenderer) => Promise<void>
    dispose: () => void
}

// Past the cap the frame keeps its extent and just gets fewer texels; the dither falls back to fragment parity.
export const liveTargetSide = (frameCells: number, maxSide: number): number =>
    Math.max(1, Math.min(maxSide, frameCells))

export const createLiveView = (camera: PerspectiveCamera): LiveView => {
    const scene = new Scene()
    const bodyCamera = new PerspectiveCamera(75, 1, 0.1, 100000)
    bodyCamera.position.z = 1
    const cameraHeight = 2 * Math.tan((bodyCamera.fov * Math.PI) / 360)
    const target = new RenderTarget(1, 1, {
        depthBuffer: false,
        stencilBuffer: false,
        minFilter: NearestFilter,
        magFilter: NearestFilter,
        generateMipmaps: false,
    })
    target.texture.colorSpace = LinearSRGBColorSpace

    // Copies the premultiplied target straight through, so the canvas holds the same values it always did.
    // Render-target UVs are y-down in three on both backends, and the plane's are y-up, hence the flip.
    const material = new MeshBasicNodeMaterial({ depthTest: false, depthWrite: false })
    material.fragmentNode = texture(target.texture, uv().flipY())
    material.blending = NoBlending
    const geometry = new PlaneGeometry(1, 1)
    const quad = new Mesh(geometry, material)
    const blitScene = new Scene()
    blitScene.add(quad)

    return {
        scene,
        camera,
        syncBody: (planet, framing, maxSide) => {
            const extent = bodyFrameExtent(planet.metadata, planet.pixels.value)
            planet.group.scale.setScalar(cameraHeight / extent)
            quad.scale.setScalar(extent * framing)
            const side = liveTargetSide(bodyFrameCells(planet.metadata, planet.pixels.value), maxSide)
            target.setSize(side, side)
        },
        render: (renderer) => {
            renderer.setClearColor(0x000000, 0)
            renderer.setRenderTarget(target)
            try {
                renderer.render(scene, bodyCamera)
            } finally {
                renderer.setRenderTarget(null)
            }
            renderer.render(blitScene, camera)
        },
        compile: async (renderer) => {
            renderer.setRenderTarget(target)
            try {
                await renderer.compileAsync(scene, bodyCamera)
            } finally {
                renderer.setRenderTarget(null)
            }
            await renderer.compileAsync(blitScene, camera)
        },
        dispose: () => {
            target.dispose()
            material.dispose()
            geometry.dispose()
        },
    }
}
