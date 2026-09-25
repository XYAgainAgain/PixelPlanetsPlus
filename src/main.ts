import { LinearSRGBColorSpace, Mesh, PerspectiveCamera, WebGPURenderer } from 'three/webgpu'
import { BACKGROUND_MODES, createBackground, type BackgroundMode } from './background'
import { createGpuContext, routeBackend, type GpuBackend, type GpuHost } from './gpu'
import { createLiveView, type LiveView } from './liveView'
import { Color } from './palette'
import { createThrottle } from './throttle'
import type { SceneComposer } from './export/composer'
import { bodyLocalToLightUv, lightUvToBodyLocal } from './export/layout'
import type { BackdropV2, SceneRecipeV2 } from './export/types'
import { decodeWorldParams, encodeWorldParams } from './export/worldParams'
import { canonicalChromaticAberration } from './export/effects'
import { LAND_PHASE_PER_QUAD } from './tsl/planets/islands'
import { PLANET_FACTORIES, createPlanet, type PlanetRuntime } from './tsl/registry'
import { PLANETS, type PlanetTypeId } from './tsl/values'

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const el = document.getElementById(id)
    if (!el) throw new Error(`missing #${id}`)
    return el as T
}

// The scene codec (and its deflate dependency) only loads for scene links and customized worlds.
const loadRecipeCodec = () => import('./export/recipe')

const seedFromUrl = (): number => {
    const raw = new URLSearchParams(location.search).get('seed')
    const n = raw === null ? NaN : Number(raw)
    return Number.isSafeInteger(n) && n >= 0 ? n : Math.floor(Math.random() * 1_000_000)
}

const backgroundFromUrl = (): BackgroundMode => {
    const raw = new URLSearchParams(location.search).get('background')
    return BACKGROUND_MODES.find((mode) => mode.toLowerCase() === raw?.toLowerCase()) ?? 'Stars'
}

const sceneFromUrl = async (): Promise<{ recipe: SceneRecipeV2 | null, warning: string | null }> => {
    const payload = new URLSearchParams(location.search).get('scene')
    if (payload === null) return { recipe: null, warning: null }
    try {
        const { decodeSceneRecipe } = await loadRecipeCodec()
        return { recipe: decodeSceneRecipe(payload), warning: null }
    } catch (error) {
        console.error('Scene link could not be decoded.', error)
        return {
            recipe: null,
            warning: "That link didn't load quite right, so we started you off with a fresh planet instead.",
        }
    }
}

const WORLD_PARAM_KEYS = ['t', 's', 'p', 'r', 'ti', 'd', 'l', 'bg', 'bs', 'pal'] as const

const hasWorldParams = (params: URLSearchParams): boolean => WORLD_PARAM_KEYS.some((key) => params.has(key))

const planetId = (planet: PlanetRuntime): PlanetTypeId => {
    const entry = Object.entries(PLANETS).find(([, metadata]) => metadata.name === planet.metadata.name)
    if (!entry) throw new Error(`unknown celestial body: ${planet.metadata.name}`)
    return entry[0] as PlanetTypeId
}

const liveBackdropRecipe = (mode: BackgroundMode, seed: number, phase: number): BackdropV2 => {
    const gradient = mode === 'Gradient' || mode === 'Stars on Gradient'
    const stars = mode === 'Stars' || mode === 'Stars on Gradient'
    return {
        base: gradient ? { kind: 'gradient', phase: ((phase % 1) + 1) % 1 } : { kind: 'transparent' },
        stars: stars ? { seed, density: 1, brightness: 1, starScale: 1, specialStarMix: 0.5 } : null,
    }
}

// The live view has no solid base, so a solid export backdrop shows as its star layer (or none).
const backgroundModeForRecipe = (backdrop: BackdropV2): BackgroundMode => {
    const gradient = backdrop.base.kind === 'gradient'
    if (backdrop.stars) return gradient ? 'Stars on Gradient' : 'Stars'
    return gradient ? 'Gradient' : 'None'
}

const framingScale = (planet: PlanetRuntime, stageAspect: number): number => {
    const displayScale = planet.metadata.guiZoom === 2.5 ? 1.5 : planet.metadata.guiZoom === 2 ? 1.25 : 1
    const requestedScale = displayScale / planet.metadata.relativeScale
    const largestLayer = Math.max(...planet.metadata.layers.map((layer) => layer.quadScale))
    const cameraHeight = 2 * Math.tan((75 * Math.PI) / 360)
    return Math.min(requestedScale, cameraHeight / largestLayer) * Math.min(1, stageAspect)
}

const disposePlanet = (planet: PlanetRuntime): void => {
    planet.group.traverse((object) => {
        if (!(object instanceof Mesh)) return
        object.geometry.dispose()
        const materials = Array.isArray(object.material) ? object.material : [object.material]
        for (const material of materials) material.dispose()
    })
    planet.group.removeFromParent()
}

// Live cap: past ~2048 the monster fragment shaders blow the 2 s GPU timeout.
const LIVE_TARGET_CAP = 2048
// Canvas reconfigures are what hang pre-155 Firefox, so stage resizes coalesce to one per 150 ms plus a settle.
const CANVAS_RESIZE_INTERVAL = 150

async function init(): Promise<void> {
    const stage = $('stage')
    // Renderer canvases mount here, not on #stage: the aberration filter must not touch text
    const canvasStack = $('canvas-stack')
    const starCanvas = $<HTMLCanvasElement>('star-layer')
    const urlParams = new URLSearchParams(location.search)
    const decodedScene = await sceneFromUrl()
    let loadedScene = decodedScene.recipe
    const hasLegacyParams = urlParams.has('seed') || urlParams.has('background')
    const seededWorldDefaults = decodeWorldParams(new URLSearchParams())
    const decodedWorld = loadedScene || decodedScene.warning || !hasWorldParams(urlParams) ? null : decodeWorldParams(urlParams)
    const loadedWorld = decodedWorld
        ? {
            ...seededWorldDefaults,
            ...decodedWorld,
            body: { ...seededWorldDefaults.body, ...decodedWorld.body },
        }
        : null
    let seed = loadedScene?.seed ?? loadedWorld?.seed ?? (decodedScene.warning || !hasLegacyParams ? 1 : seedFromUrl())
    const seedInput = $<HTMLInputElement>('seed-value')
    seedInput.value = String(seed)

    const backendOf = (candidate: WebGPURenderer): GpuBackend => {
        const backend = candidate.backend as unknown as { isWebGPUBackend?: boolean }
        return backend.isWebGPUBackend ? 'webgpu' : 'webgl'
    }
    const initializeForcedWebGL = async (canvas?: HTMLCanvasElement): Promise<WebGPURenderer> => {
        const fallback = new WebGPURenderer({ antialias: false, alpha: true, forceWebGL: true, canvas })
        let watchdog = 0
        try {
            await Promise.race([
                fallback.init(),
                new Promise<never>((_, reject) => {
                    watchdog = window.setTimeout(() => { reject(new Error('Forced WebGL initialization timed out after 4 seconds')) }, 4000)
                }),
            ])
            console.info(`Renderer backend: ${backendOf(fallback)} (forced fallback)`)
            return fallback
        } catch (error: unknown) {
            fallback.dispose()
            throw error
        } finally {
            window.clearTimeout(watchdog)
        }
    }
    const initializeRenderer = async (canvas?: HTMLCanvasElement): Promise<{ renderer: WebGPURenderer, forced: boolean }> => {
        const route = routeBackend(location.search, navigator.userAgent)
        if (route.backend === 'webgl') {
            console.info(`${route.reason}; using WebGL.`)
            return { renderer: await initializeForcedWebGL(canvas), forced: true }
        }
        const primary = new WebGPURenderer({ antialias: false, alpha: true, canvas })
        let watchdog = 0
        try {
            await Promise.race([
                primary.init(),
                new Promise<never>((_, reject) => {
                    watchdog = window.setTimeout(() => { reject(new Error('WebGPU initialization timed out after 4 seconds')) }, 4000)
                }),
            ])
            console.info(`Renderer backend: ${backendOf(primary)} (${route.reason})`)
            return { renderer: primary, forced: false }
        } catch (error: unknown) {
            console.info('WebGPU initialization failed or stalled; trying forced WebGL.', error)
            primary.dispose()
        } finally {
            window.clearTimeout(watchdog)
        }

        return { renderer: await initializeForcedWebGL(canvas), forced: true }
    }

    let initialized = await initializeRenderer()
    let renderer = initialized.renderer
    let rendererWasForced = initialized.forced
    const configureRenderer = (candidate: WebGPURenderer): void => {
        // Legacy r139 wrote gl_FragColor straight to canvas; linear output matches the look
        candidate.outputColorSpace = LinearSRGBColorSpace
        candidate.setPixelRatio(1)
        candidate.setClearColor(0x000000, 0)
    }
    configureRenderer(renderer)

    // One renderer for the whole page: the live view, the composer preview, and every export share it.
    let gpuGeneration = 0
    let gpuState = createGpuContext(renderer, backendOf(renderer), gpuGeneration)
    const gpu: GpuHost = { current: () => gpuState.context }
    const adoptRenderer = (next: WebGPURenderer): void => {
        gpuState.markLost()
        renderer = next
        gpuGeneration += 1
        gpuState = createGpuContext(renderer, backendOf(renderer), gpuGeneration)
    }
    const liveTargetCap = (): number => Math.min(LIVE_TARGET_CAP, gpu.current().textureLimit)

    const camera = new PerspectiveCamera(75, 1, 0.1, 100000)
    camera.position.z = 1
    let liveView: LiveView = createLiveView(camera)

    const loadedRecipe = loadedScene ?? loadedWorld
    let planet = createPlanet(loadedRecipe?.celestialType ? PLANETS[loadedRecipe.celestialType].name : 'Islands', seed)
    let defaultLight = planet.lightOrigin
        ? lightUvToBodyLocal([planet.lightOrigin.value.x, planet.lightOrigin.value.y])
        : null
    if (loadedRecipe) {
        planet.pixels.value = loadedRecipe.pixels ?? planet.pixels.value
        planet.rotation.value = loadedRecipe.body?.rotation ?? planet.rotation.value
        planet.setDither(loadedRecipe.dither ?? true)
        if (loadedRecipe.palette) planet.palette.setColors(loadedRecipe.palette.flat().map(Color.fromHex))
        const layerIndices = new Map(planet.metadata.layers.map((layer, index) => [layer.node, index]))
        for (const layer of loadedRecipe.layers ?? []) {
            const index = layerIndices.get(layer.id)
            if (index !== undefined) planet.setLayerVisible(index, layer.visible)
        }
        if (loadedRecipe.body?.light && planet.lightOrigin) planet.lightOrigin.value.set(...bodyLocalToLightUv(loadedRecipe.body.light))
    }
    liveView.scene.add(planet.group)
    const safeBackground = (mode: BackgroundMode, backgroundSeed: number) => {
        try {
            return createBackground(mode, backgroundSeed, starCanvas)
        } catch (error: unknown) {
            console.error('Background initialization failed; continuing with black.', error)
            return createBackground('None', backgroundSeed, starCanvas)
        }
    }
    let backgroundSeed = loadedRecipe?.backdrop?.stars?.seed ?? seed
    let background = safeBackground(loadedRecipe?.backdrop
        ? backgroundModeForRecipe(loadedRecipe.backdrop)
        : decodedScene.warning ? 'Stars' : backgroundFromUrl(), backgroundSeed)

    let canvas = renderer.domElement

    // Pixels and planet changes only touch the body target, never the canvas context.
    const syncBody = (): void => {
        liveView.syncBody(planet, framingScale(planet, camera.aspect), liveTargetCap())
    }

    let bufferWidth = 0
    let bufferHeight = 0
    // The canvas follows the stage's device-pixel box only, so a Pixels drag never reconfigures it.
    const applyCanvasSize = (): void => {
        const w = stage.clientWidth
        const h = stage.clientHeight
        // A collapsed flex stage would mean aspect NaN and a zero-size GPU texture
        if (w === 0 || h === 0) return
        camera.aspect = w / h
        camera.updateProjectionMatrix()
        const ratio = window.devicePixelRatio || 1
        const limit = gpu.current().textureLimit
        const fit = Math.min(1, limit / Math.max(w * ratio, h * ratio))
        const nextWidth = Math.max(1, Math.round(w * ratio * fit))
        const nextHeight = Math.max(1, Math.round(h * ratio * fit))
        if (nextWidth !== bufferWidth || nextHeight !== bufferHeight) {
            renderer.setSize(nextWidth, nextHeight, false)
            bufferWidth = nextWidth
            bufferHeight = nextHeight
        }
        syncBody()
        background.resize(w, h, planet.pixels.value)
    }
    const canvasResize = createThrottle(applyCanvasSize, CANVAS_RESIZE_INTERVAL)
    const resize = (): void => { canvasResize.request() }
    new ResizeObserver(resize).observe(stage)
    // Android keyboards resize the visual viewport without always re-firing the observer;
    // re-running layout when the viewport settles un-wedges the stage after keyboard close
    window.visualViewport?.addEventListener('resize', resize)
    // Zoom changes devicePixelRatio, which no ResizeObserver content box reports.
    window.addEventListener('resize', resize)

    canvasStack.appendChild(renderer.domElement)
    applyCanvasSize()
    background.update(0, 0)

    const presentFirstFrame = async (candidate: WebGPURenderer): Promise<void> => {
        // compileAsync never settles on Firefox (both backends); treat it as a best-effort
        // warmup with a 3 s budget and rely on render()'s synchronous compile path instead.
        await Promise.race([
            liveView.compile(candidate).catch(() => {}),
            new Promise<void>((resolve) => { window.setTimeout(resolve, 3000) }),
        ])
        liveView.render(candidate)
        await new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve() }) })
    }

    try {
        await presentFirstFrame(renderer)
        console.info(`First frame presented with ${backendOf(renderer)}.`)
    } catch (error: unknown) {
        if (rendererWasForced) throw error
        console.info('First WebGPU frame failed or stalled; rebuilding with forced WebGL.', error)
        renderer.dispose()
        canvas.remove()
        disposePlanet(planet)
        liveView.dispose()
        liveView = createLiveView(camera)
        planet = createPlanet('Islands', seed)
        defaultLight = planet.lightOrigin
            ? lightUvToBodyLocal([planet.lightOrigin.value.x, planet.lightOrigin.value.y])
            : null
        liveView.scene.add(planet.group)
        adoptRenderer(await initializeForcedWebGL())
        rendererWasForced = true
        configureRenderer(renderer)
        canvas = renderer.domElement
        canvasStack.appendChild(canvas)
        bufferWidth = 0
        bufferHeight = 0
        applyCanvasSize()
        await presentFirstFrame(renderer)
        console.info('First frame presented with forced WebGL after WebGPU first-frame failure.')
    }
    $('stage-placeholder').remove()
    if (decodedScene.warning) {
        const warning = document.createElement('p')
        warning.className = 'absolute top-3 left-1/2 z-20 max-w-xl -translate-x-1/2 rounded border border-amber-700 bg-amber-950/95 px-3 py-2 text-xs text-amber-100'
        warning.setAttribute('role', 'status')
        warning.textContent = decodedScene.warning
        stage.appendChild(warning)
    }

    // Drag does two things depending on where it starts: off the disc it moves the light like
    // the Godot original, on the disc it spins the planet. Mode locks at pointerdown.
    canvas.style.touchAction = 'none'
    // Past 1.1 from disc center every pixel clears light_border_2 and the planet goes flat
    // black; 0.85 keeps a lit crescent no matter how far the drag wanders.
    const LIGHT_REACH = 0.85
    // Scrubbed against the land layer, which is the thing the eye tracks. Negative because
    // advancing time slides the surface against the drag, not with it.
    const SCRUB_PER_UV = -LAND_PHASE_PER_QUAD
    const MOMENTUM_TAU = 0.5
    const PHASE_WRAP = 1_000
    // A flick faster than 20 quad widths/second is a glitchy sample, not an intent
    const MAX_FLICK = 20 * Math.abs(SCRUB_PER_UV)

    // The quad is 1 unit tall at the camera's unit distance, so its on-screen side is the view
    // height there. Screen y-down matches the shaders' Godot UV space, so no flip anywhere.
    const quadUvFromPointer = (e: PointerEvent): { x: number, y: number } | null => {
        const rect = canvas.getBoundingClientRect()
        if (rect.height === 0) return null
        const quadPx = rect.height / (2 * Math.tan((camera.fov * Math.PI) / 360))
        const scale = framingScale(planet, camera.aspect)
        return {
            x: (e.clientX - (rect.left + rect.width / 2)) / (quadPx * scale) + 0.5,
            y: (e.clientY - (rect.top + rect.height / 2)) / (quadPx * scale) + 0.5,
        }
    }

    const setLight = (uv: { x: number, y: number }): void => {
        const dx = uv.x - 0.5
        const dy = uv.y - 0.5
        const d = Math.hypot(dx, dy)
        if (d > LIGHT_REACH) {
            planet.lightOrigin?.value.set(0.5 + (dx / d) * LIGHT_REACH, 0.5 + (dy / d) * LIGHT_REACH)
        } else {
            planet.lightOrigin?.value.set(uv.x, uv.y)
        }
        scheduleSceneUrl()
    }

    // Each layer scrolls the shared phase at its own Godot-derived rate, so phase is just
    // Godot's seconds and slider 0.1 means 1×: one full surface wrap every 25 seconds.
    let speed = -0.1
    let phase = loadedRecipe?.body?.phase ?? 0
    let sharedPhase = phase
    let last = -1
    // Leftover phase rate from a flick, in phase units per second, decaying back to baseline
    let momentum = 0

    let dragMode: 'light' | 'spin' | null = null
    let dragPointerId = -1
    let lastDragX = 0
    let lastDragT = 0
    let dragVelocity = 0

    canvas.addEventListener('pointerdown', (e) => {
        // A second finger must not retarget a drag whose mode is already locked
        if (dragMode !== null) return
        const uv = quadUvFromPointer(e)
        if (!uv) return
        canvas.setPointerCapture(e.pointerId)
        dragPointerId = e.pointerId
        if (Math.hypot(uv.x - 0.5, uv.y - 0.5) <= 0.5) {
            dragMode = 'spin'
            lastDragX = uv.x
            lastDragT = e.timeStamp / 1000
            dragVelocity = 0
            momentum = 0
        } else {
            if (planet.metadata.lightDrag && planet.lightOrigin) {
                dragMode = 'light'
                setLight(uv)
            } else {
                canvas.releasePointerCapture(e.pointerId)
                dragPointerId = -1
            }
        }
    })

    canvas.addEventListener('pointermove', (e) => {
        if (dragMode === null || e.pointerId !== dragPointerId) return
        const uv = quadUvFromPointer(e)
        if (!uv) return
        if (dragMode === 'light') {
            setLight(uv)
            return
        }
        const now = e.timeStamp / 1000
        const dt = now - lastDragT
        const dPhase = (uv.x - lastDragX) * SCRUB_PER_UV
        phase = (phase + dPhase + PHASE_WRAP) % PHASE_WRAP
        sharedPhase = phase
        scheduleSceneUrl()
        if (dt > 0) {
            const v = Math.max(-MAX_FLICK, Math.min(MAX_FLICK, dPhase / dt))
            // Blend so one stuttering frame can't define the flick; the first sample of a
            // drag has nothing to blend with (velocity is zeroed at pointerdown).
            dragVelocity = dragVelocity === 0 ? v : dragVelocity * 0.5 + v * 0.5
        }
        lastDragX = uv.x
        lastDragT = now
    })

    const endDrag = (e: PointerEvent, keepMomentum: boolean): void => {
        if (e.pointerId !== dragPointerId) return
        if (dragMode === 'spin' && keepMomentum) {
            // A pointer parked for a beat before release is a placement, not a throw
            momentum = (e.timeStamp / 1000 - lastDragT) < 0.12 ? dragVelocity : 0
        }
        dragMode = null
        dragPointerId = -1
        dragVelocity = 0
    }
    canvas.addEventListener('pointerup', (e) => { endDrag(e, true) })
    canvas.addEventListener('pointercancel', (e) => { endDrag(e, false) })

    // Sampled every quarter second: a per-frame readout is unreadable and churns layout
    const fpsOut = $('fps')
    let fpsFrames = 0
    let fpsSince = -1

    const animate = (timeMs: number): void => {
        const t = timeMs / 1000
        // An export or preview holds the shared renderer: freeze on the last frame, resume without a jump.
        if (gpu.current().queue.busy()) {
            last = t
            fpsFrames = 0
            fpsSince = -1
            return
        }
        if (fpsSince < 0) fpsSince = t
        else if (t - fpsSince >= 0.25) {
            fpsOut.textContent = `FPS: ${Math.round(fpsFrames / (t - fpsSince))}`
            fpsFrames = 0
            fpsSince = t
        }
        fpsFrames += 1
        // Clamp: a backgrounded tab returns with a multi-second gap that would teleport the
        // surface and turn any live momentum into one enormous jump.
        const dt = last < 0 ? 0 : Math.min(t - last, 0.1)
        last = t
        // Slider is negated from Godot's baseline on purpose: right = surface drifts right
        // (counterclockwise from the north pole). Flick momentum rides on top and decays.
        phase = (phase + dt * (momentum - speed / 0.1) + PHASE_WRAP) % PHASE_WRAP
        if (momentum !== 0) {
            momentum *= Math.exp(-dt / MOMENTUM_TAU)
            if (Math.abs(momentum) < 1) momentum = 0
        }
        planet.updateTime(phase)
        background.update(t, dt)
        try {
            liveView.render(renderer)
        } catch (error: unknown) {
            if (background.mode === 'None') throw error
            console.error('Background rendering failed; continuing with black.', error)
            background.dispose()
            background = safeBackground('None', backgroundSeed)
            liveView.render(renderer)
        }
    }

    const syncAnimationLoop = (): void => {
        if (recovering) {
            renderer.setAnimationLoop(null)
            return
        }
        renderer.setAnimationLoop(document.hidden ? null : animate)
        if (!document.hidden) {
            last = -1
            fpsFrames = 0
            fpsSince = -1
        }
    }

    let recoveryAttempted = false
    let recovering = false
    const showRendererMessage = (message: string): void => {
        let output = document.getElementById('renderer-status')
        if (!output) {
            output = document.createElement('p')
            output.id = 'renderer-status'
            output.className = 'pointer-events-none absolute inset-x-6 top-6 z-10 rounded-lg border border-red-800 bg-red-950/90 p-3 text-center text-sm text-red-100'
            output.setAttribute('role', 'alert')
            stage.appendChild(output)
        }
        output.textContent = message
    }

    const installDeviceLossHandler = (): void => {
        renderer.onDeviceLost = (info): void => {
            if (recovering) return
            renderer.setAnimationLoop(null)
            // In-flight exports and previews reject with a visible message instead of waiting forever.
            gpuState.markLost()
            console.error(`WebGPU device lost: ${info.message}`, info.originalEvent)
            if (recoveryAttempted) {
                recovering = true
                showRendererMessage('The graphics device was lost again. Reload the page to retry.')
                return
            }
            recoveryAttempted = true
            recovering = true
            showRendererMessage('The graphics device was lost. Attempting to recover…')
            const lostRenderer = renderer
            void (async () => {
                try {
                    lostRenderer.dispose()
                    initialized = await initializeRenderer(canvas)
                    adoptRenderer(initialized.renderer)
                    rendererWasForced = initialized.forced
                    configureRenderer(renderer)
                    installDeviceLossHandler()
                    bufferWidth = 0
                    bufferHeight = 0
                    applyCanvasSize()
                    document.getElementById('renderer-status')?.remove()
                    recovering = false
                    syncAnimationLoop()
                } catch (error: unknown) {
                    recovering = true
                    renderer.setAnimationLoop(null)
                    showRendererMessage('Graphics recovery failed. Reload the page to retry.')
                    console.error(error)
                }
            })()
        }
    }
    installDeviceLossHandler()
    document.addEventListener('visibilitychange', syncAnimationLoop)
    syncAnimationLoop()

    // Controls
    const typeSelect = $<HTMLSelectElement>('planet-type')
    typeSelect.replaceChildren(...PLANET_FACTORIES.map(({ metadata }) => new Option(metadata.name, metadata.name)))
    typeSelect.value = planet.metadata.name
    const backgroundSelect = $<HTMLSelectElement>('background-mode')
    backgroundSelect.value = background.mode

    backgroundSelect.addEventListener('change', () => {
        const outgoing = background
        background = safeBackground(backgroundSelect.value as BackgroundMode, backgroundSeed)
        outgoing.dispose()
        background.resize(stage.clientWidth, stage.clientHeight, planet.pixels.value)
    })

    const pixelsInput = $<HTMLInputElement>('pixels')
    const pixelsNumber = $<HTMLInputElement>('pixels-number')
    const tiltInput = $<HTMLInputElement>('tilt')
    const ditherInput = $<HTMLInputElement>('dither')
    const caToggle = $<HTMLInputElement>('ca-toggle')
    const layerOptions = $('layer-options')
    const paletteSwatches = $('palette-swatches')
    const palettePicker = $<HTMLInputElement>('palette-picker')
    const paletteDialog = $<HTMLDialogElement>('palette-dialog')
    const paletteText = $<HTMLTextAreaElement>('palette-text')
    const paletteMessage = $<HTMLOutputElement>('palette-message')
    let activeSwatch = 0

    const syncPalette = (): void => {
        const colors = planet.palette.colors()
        activeSwatch = Math.min(activeSwatch, colors.length - 1)
        paletteSwatches.replaceChildren(...colors.map((color, index) => {
            const swatch = document.createElement('button')
            swatch.type = 'button'
            swatch.className = 'palette-swatch'
            swatch.style.setProperty('--swatch', color.toHex())
            swatch.setAttribute('aria-label', `Color ${index + 1}: ${color.toHex()}`)
            swatch.setAttribute('aria-pressed', String(index === activeSwatch))
            swatch.addEventListener('click', () => {
                activeSwatch = index
                syncPalette()
                palettePicker.click()
            })
            return swatch
        }))
        palettePicker.value = colors[activeSwatch]?.toHex() ?? '#000000'
    }


    const syncLayers = (): void => {
        const layerIndices = planet.metadata.layerMenu ?? planet.metadata.layers.map((_, index) => index)
        layerOptions.replaceChildren(...layerIndices.map((index) => {
            const layer = planet.metadata.layers[index]!
            const label = document.createElement('label')
            label.className = 'flex items-center gap-2 text-sm text-zinc-300'
            const checkbox = document.createElement('input')
            checkbox.type = 'checkbox'
            checkbox.checked = planet.group.children[index]?.visible ?? true
            checkbox.addEventListener('change', () => {
                planet.setLayerVisible(index, checkbox.checked)
            })
            label.append(checkbox, document.createTextNode(layer.node))
            return label
        }))
    }

    const syncDither = (): void => {
        planet.setDither(ditherInput.checked)
        ditherInput.disabled = planet.metadata.ditherLayers.length === 0
    }

    const syncPlanetControls = (): void => {
        if (!loadedScene) {
            planet.pixels.value = Number(pixelsNumber.value)
            planet.rotation.value = Number(tiltInput.value)
        }
        syncDither()
        syncLayers()
        activeSwatch = 0
        syncPalette()
        syncBody()
        background.resize(stage.clientWidth, stage.clientHeight, planet.pixels.value)
    }

    typeSelect.addEventListener('change', () => {
        const outgoing = planet
        planet = createPlanet(typeSelect.value, seed)
        planet.pixels.value = Number(pixelsNumber.value)
        planet.rotation.value = Number(tiltInput.value)
        defaultLight = planet.lightOrigin
            ? lightUvToBodyLocal([planet.lightOrigin.value.x, planet.lightOrigin.value.y])
            : null
        liveView.scene.add(planet.group)
        disposePlanet(outgoing)
        syncPlanetControls()
    })

    $('seed-reroll').addEventListener('click', () => {
        seed = Math.floor(Math.random() * 1_000_000)
        backgroundSeed = seed
        planet.reseed(seed)
        background.reseed(backgroundSeed)
        seedInput.value = String(seed)
        syncPalette()
    })

    const applySeedInput = (): void => {
        const next = Number(seedInput.value)
        if (!Number.isSafeInteger(next) || next < 0) {
            seedInput.value = String(seed)
            return
        }
        seed = next
        backgroundSeed = seed
        seedInput.value = String(seed)
        planet.reseed(seed)
        background.reseed(backgroundSeed)
        syncPalette()
    }
    seedInput.addEventListener('change', applySeedInput)

    const clampPixels = (value: number): number => Math.max(12, Math.min(2048, Math.round(value)))
    const syncPixels = (source: HTMLInputElement): void => {
        const pixels = clampPixels(Number(source.value))
        pixelsInput.value = String(pixels)
        pixelsNumber.value = String(pixels)
        planet.pixels.value = pixels
        // Live on every tick: only the body target reallocates, the canvas keeps its size.
        syncBody()
        background.resize(stage.clientWidth, stage.clientHeight, pixels)
    }
    pixelsInput.addEventListener('input', () => { syncPixels(pixelsInput) })
    pixelsNumber.addEventListener('change', () => { syncPixels(pixelsNumber) })
    syncPixels(pixelsNumber)

    $('pixel-presets').addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-px]')
        if (!btn?.dataset['px']) return
        pixelsNumber.value = btn.dataset['px']
        syncPixels(pixelsNumber)
    })

    // The signed speed slider fills from the center out; --frac drives that gradient
    const setCenterFill = (input: HTMLInputElement): void => {
        const lo = Number(input.min)
        const hi = Number(input.max)
        input.style.setProperty('--frac', String((Number(input.value) - lo) / (hi - lo)))
    }

    const speedInput = $<HTMLInputElement>('rotation-speed')
    const syncSpeed = (): void => {
        speed = Number(speedInput.value)
        $('rotation-speed-value').textContent = speedInput.value
        setCenterFill(speedInput)
    }
    speedInput.addEventListener('input', syncSpeed)
    syncSpeed()

    // Godot's "Rotation" slider is axial tilt, a static roll of the sampled UV, not a rate
    const syncTilt = (): void => {
        planet.rotation.value = Number(tiltInput.value)
        $('tilt-value').textContent = tiltInput.value
    }
    tiltInput.addEventListener('input', syncTilt)
    syncTilt()

    ditherInput.addEventListener('change', syncDither)

    caToggle.addEventListener('change', () => {
        // Body-level class so one toggle covers the stage and the aberrated header
        document.body.classList.toggle('ca-off', !caToggle.checked)
    })

    palettePicker.addEventListener('input', () => {
        const colors = planet.palette.colors()
        colors[activeSwatch] = Color.fromHex(palettePicker.value)
        planet.palette.setColors(colors)
        syncPalette()
    })

    $('palette-random').addEventListener('click', () => {
        planet.palette.randomize()
        syncPalette()
    })

    $('palette-reset').addEventListener('click', () => {
        planet.palette.reset()
        syncPalette()
    })

    $('palette-transfer').addEventListener('click', () => {
        paletteText.value = planet.palette.colors().map((color) => color.toHex()).join('\n')
        paletteMessage.value = ''
        paletteDialog.showModal()
    })

    $('palette-copy').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(paletteText.value)
            paletteMessage.value = 'Copied palette.'
        } catch (error: unknown) {
            paletteMessage.value = 'Clipboard copy failed.'
            console.error(error)
        }
    })

    $('palette-paste').addEventListener('click', async () => {
        try {
            paletteText.value = await navigator.clipboard.readText()
            paletteMessage.value = 'Pasted palette.'
        } catch (error: unknown) {
            paletteMessage.value = 'Clipboard paste failed.'
            console.error(error)
        }
    })

    $('palette-apply').addEventListener('click', () => {
        const colors = paletteText.value.replaceAll(',', '').split(/\r?\n/).map((line) => {
            try {
                return Color.fromHex(line.trim())
            } catch {
                return Color.fromHex('#000000')
            }
        })
        planet.palette.setColors(colors)
        paletteMessage.value = 'Applied palette.'
        syncPalette()
    })

    syncPlanetControls()

    if (loadedRecipe) {
        pixelsInput.value = String(loadedRecipe.pixels ?? planet.pixels.value)
        pixelsNumber.value = String(loadedRecipe.pixels ?? planet.pixels.value)
        tiltInput.value = String(loadedRecipe.body?.rotation ?? planet.rotation.value)
        ditherInput.checked = loadedRecipe.dither ?? true
        syncPlanetControls()
    }

    const liveExportCanvasSize = (): { width: number, height: number } => {
        const aspect = stage.clientWidth / Math.max(1, stage.clientHeight)
        return aspect >= 1
            ? { width: 1920, height: Math.max(1, Math.round(1920 / aspect)) }
            : { width: Math.max(1, Math.round(1920 * aspect)), height: 1920 }
    }
    const makeCurrentRecipe = (): SceneRecipeV2 => {
        const canvasSize = liveExportCanvasSize()
        const source = composer?.recipe()
        const composing = !$('export-workspace').hidden
        return {
            schema: 'pixelplanetsplus-scene@2',
            celestialType: planetId(planet),
            canvas: composing ? source?.canvas ?? canvasSize : loadedScene?.canvas ?? canvasSize,
            body: {
                center: composing ? source?.body.center ?? [0.5, 0.5] : loadedScene?.body.center ?? [0.5, 0.5],
                phase: composing ? source?.body.phase ?? sharedPhase % 1 : loadedScene?.body.phase ?? sharedPhase % 1,
                rotation: planet.rotation.value,
                light: composing ? source?.body.light ?? null : loadedScene?.body.light
                    ?? (planet.lightOrigin
                        ? lightUvToBodyLocal([planet.lightOrigin.value.x, planet.lightOrigin.value.y])
                        : null),
            },
            seed,
            pixels: planet.pixels.value,
            palette: [planet.palette.colors().map((color) => color.toHex())],
            layers: planet.metadata.layers.map((layer, index) => ({ id: layer.node, visible: planet.group.children[index]?.visible ?? true })),
            // The composer's Dither box defaults to the live toggle but may differ for the export alone.
            dither: composing ? source?.dither ?? ditherInput.checked : ditherInput.checked,
            backdrop: composing ? source?.backdrop ?? liveBackdropRecipe(background.mode, backgroundSeed, 0)
                : loadedScene?.backdrop ?? liveBackdropRecipe(background.mode, backgroundSeed, 0),
            export: composing ? source?.export ?? loadedScene?.export ?? {
                scale: 1, frameCount: 60, columns: 8, margin: 0,
                startPhase: 0, endPhase: 1, direction: 'forward', framesPerSecond: 12,
            } : loadedScene?.export ?? source?.export ?? {
                scale: 1, frameCount: 60, columns: 8, margin: 0,
                startPhase: 0, endPhase: 1, direction: 'forward', framesPerSecond: 12,
            },
            effects: composing ? source?.effects ?? [] : loadedScene?.effects ?? [],
        }
    }
    let sceneWriteTimer = 0
    let sceneWriteTicket = 0
    const samePair = (left: readonly [number, number] | null, right: readonly [number, number] | null): boolean =>
        left === right || (left !== null && right !== null && left[0] === right[0] && left[1] === right[1])
    const needsSceneUrl = (recipe: SceneRecipeV2): boolean => {
        const canvasSize = liveExportCanvasSize()
        const { base, stars } = recipe.backdrop
        // World-param links rebuild the live backdrop, which has no solid base, so a matte needs the scene link.
        const customBackdrop = base.kind === 'solid' || (base.kind === 'gradient' && base.phase !== 0)
            || (stars !== null && (stars.density !== 1 || stars.brightness !== 1 || stars.starScale !== 1 || stars.specialStarMix !== 0.5))
        // The composer derives its framing from the stage, so compare loosely: rounding alone is not a customization.
        const near = (value: number, reference: number, tolerance = 1e-4): boolean => Math.abs(value - reference) <= tolerance
        return !near(recipe.canvas.width, canvasSize.width, 1) || !near(recipe.canvas.height, canvasSize.height, 1)
            || !near(recipe.body.center[0], 0.5) || !near(recipe.body.center[1], 0.5)
            || !samePair(recipe.body.light, defaultLight) || customBackdrop
            || recipe.export.scale !== 1 || recipe.export.frameCount !== 60 || recipe.export.columns !== 8
            || recipe.export.margin !== 0 || recipe.export.startPhase !== 0 || recipe.export.endPhase !== 1
            || recipe.export.direction !== 'forward' || recipe.export.framesPerSecond !== 12
            // Chromatic aberration left on is the page default the composer restores, so only other effects count.
            || recipe.effects.some((effect) => effect !== canonicalChromaticAberration(recipe.effects) || !effect.enabled)
    }
    const scheduleSceneUrl = (): void => {
        window.clearTimeout(sceneWriteTimer)
        sceneWriteTimer = window.setTimeout(() => {
            // The codec loads lazily, so a slow import must never land after a newer write.
            const ticket = ++sceneWriteTicket
            void (async () => {
                try {
                    const url = new URL(location.href)
                    const recipe = makeCurrentRecipe()
                    url.searchParams.delete('scene')
                    url.searchParams.delete('seed')
                    url.searchParams.delete('background')
                    for (const key of WORLD_PARAM_KEYS) url.searchParams.delete(key)
                    if (needsSceneUrl(recipe)) {
                        const { encodeSceneRecipe } = await loadRecipeCodec()
                        url.searchParams.set('scene', encodeSceneRecipe(recipe))
                    } else {
                        for (const [key, value] of encodeWorldParams(recipe)) url.searchParams.set(key, value)
                    }
                    if (ticket === sceneWriteTicket) history.replaceState(null, '', url)
                } catch (error: unknown) {
                    console.error('Scene URL update failed.', error)
                }
            })()
        }, 300)
    }
    // The export suite (encoders, zip, compositor) is a separate chunk, fetched the first time it is wanted.
    let composer: SceneComposer | null = null
    let composerLoading: Promise<SceneComposer> | null = null
    const loadComposer = (): Promise<SceneComposer> => {
        composerLoading ??= import('./export/composer').then(({ createSceneComposer }) => {
            composer = createSceneComposer({
                stage,
                gpu,
                currentRecipe: makeCurrentRecipe,
                liveChromaticAberration: () => caToggle.checked,
                setPixels: (pixels) => {
                    pixelsNumber.value = String(pixels)
                    syncPixels(pixelsNumber)
                    scheduleSceneUrl()
                    return planet.pixels.value
                },
                onRecipeChange: (recipe) => { loadedScene = recipe; scheduleSceneUrl() },
                onClose: (_recipe, changed) => {
                    if (changed) loadedScene = _recipe
                    scheduleSceneUrl()
                },
            })
            return composer
        }).catch((error: unknown) => {
            composerLoading = null
            throw error
        })
        return composerLoading
    }
    for (const format of ['png', 'gif', 'spritesheet'] as const) {
        const button = $(`export-${format}`)
        // Warm the chunk on intent so the workspace opens without a visible wait.
        const prefetch = (): void => { loadComposer().catch(() => {}) }
        button.addEventListener('pointerenter', prefetch, { once: true })
        button.addEventListener('focus', prefetch, { once: true })
        button.addEventListener('click', () => {
            loadComposer().then((loaded) => { loaded.open(format) }).catch((error: unknown) => {
                console.error('Export tools failed to load.', error)
                showRendererMessage('The export tools could not load. Check your connection, then try again.')
                window.setTimeout(() => { if (!recovering) document.getElementById('renderer-status')?.remove() }, 5000)
            })
        })
    }
    const liveControls = [typeSelect, pixelsInput, pixelsNumber, tiltInput, ditherInput, palettePicker]
    for (const control of liveControls) {
        control.addEventListener('input', () => { composer?.refreshFromLive(); scheduleSceneUrl() })
        control.addEventListener('change', () => { composer?.refreshFromLive(); scheduleSceneUrl() })
    }
    for (const control of [backgroundSelect, seedInput]) {
        control.addEventListener('input', () => { composer?.refreshFromLive(); scheduleSceneUrl() })
        control.addEventListener('change', () => { composer?.refreshFromLive(); scheduleSceneUrl() })
    }
    layerOptions.addEventListener('change', scheduleSceneUrl)
    $('seed-reroll').addEventListener('click', scheduleSceneUrl)
    $('palette-random').addEventListener('click', scheduleSceneUrl)
    $('palette-reset').addEventListener('click', scheduleSceneUrl)
    scheduleSceneUrl()
}

init().catch((err: unknown) => {
    // The placeholder is gone once the canvas mounts; never let this handler throw!
    const placeholder = document.getElementById('stage-placeholder')
    if (placeholder) placeholder.textContent = 'renderer failed to start, check the console'
    console.error(err)
})
