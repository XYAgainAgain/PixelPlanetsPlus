import { LinearSRGBColorSpace, Mesh, PerspectiveCamera, Scene, WebGPURenderer } from 'three/webgpu'
import { BACKGROUND_MODES, createBackground, type BackgroundMode } from './background'
import { Color } from './palette'
import { LAND_PHASE_PER_QUAD } from './tsl/planets/islands'
import { PLANET_FACTORIES, createPlanet, type PlanetRuntime } from './tsl/registry'

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const el = document.getElementById(id)
    if (!el) throw new Error(`missing #${id}`)
    return el as T
}

const seedFromUrl = (): number => {
    const raw = new URLSearchParams(location.search).get('seed')
    const n = raw === null ? NaN : Number.parseInt(raw, 10)
    return Number.isFinite(n) ? n : Math.floor(Math.random() * 1_000_000)
}

const writeSeedToUrl = (seed: number): void => {
    const url = new URL(location.href)
    url.searchParams.set('seed', String(seed))
    history.replaceState(null, '', url)
}

const backgroundFromUrl = (): BackgroundMode => {
    const raw = new URLSearchParams(location.search).get('background')
    return BACKGROUND_MODES.find((mode) => mode.toLowerCase() === raw?.toLowerCase()) ?? 'Stars'
}

const writeBackgroundToUrl = (mode: BackgroundMode): void => {
    const url = new URL(location.href)
    url.searchParams.set('background', mode.toLowerCase())
    history.replaceState(null, '', url)
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

async function init(): Promise<void> {
    const stage = $('stage')
    // Renderer canvases mount here, not on #stage: the aberration filter must not touch text
    const canvasStack = $('canvas-stack')
    const starCanvas = $<HTMLCanvasElement>('star-layer')
    let seed = seedFromUrl()
    writeSeedToUrl(seed)
    const seedInput = $<HTMLInputElement>('seed-value')
    seedInput.value = String(seed)

    const backendName = (candidate: WebGPURenderer): string => {
        const backend = candidate.backend as unknown as { isWebGPUBackend?: boolean, isWebGLBackend?: boolean }
        if (backend.isWebGPUBackend) return 'WebGPU'
        if (backend.isWebGLBackend) return 'WebGL'
        return 'unknown'
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
            console.info(`Renderer backend: ${backendName(fallback)} (forced fallback)`)
            return fallback
        } catch (error: unknown) {
            fallback.dispose()
            throw error
        } finally {
            window.clearTimeout(watchdog)
        }
    }
    const initializeRenderer = async (canvas?: HTMLCanvasElement): Promise<{ renderer: WebGPURenderer, forced: boolean }> => {
        // ?backend=webgl forces the Firefox code path anywhere, for debugging the fallback
        if (new URLSearchParams(location.search).get('backend') === 'webgl') {
            console.info('backend=webgl requested; forcing WebGL.')
            return { renderer: await initializeForcedWebGL(canvas), forced: true }
        }
        // Firefox WebGPU (2026-08) hangs on swapchain resize; WebGL2 there for now
        if (navigator.userAgent.includes('Firefox/')) {
            console.info('Firefox detected; using WebGL until its WebGPU handles resizes.')
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
            console.info(`Renderer backend: ${backendName(primary)}`)
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

    const scene = new Scene()
    const camera = new PerspectiveCamera(75, 1, 0.1, 100000)
    camera.position.z = 1

    let planet = createPlanet('Islands', seed)
    scene.add(planet.group)
    const safeBackground = (mode: BackgroundMode, backgroundSeed: number) => {
        try {
            return createBackground(mode, backgroundSeed, starCanvas)
        } catch (error: unknown) {
            console.error('Background initialization failed; continuing with black.', error)
            return createBackground('None', backgroundSeed, starCanvas)
        }
    }
    let background = safeBackground(backgroundFromUrl(), seed)

    let canvas = renderer.domElement
    const rendererLimit = (): number => {
        // Live cap: past ~2048 the monster fragment shaders blow the 2 s GPU timeout (Sam's call).
        // Exports/CLI render offline later at full resolution.
        try {
            const backend = renderer.backend as unknown as {
                device?: { limits?: { maxTextureDimension2D?: unknown } }
            }
            const deviceLimit = backend?.device?.limits?.maxTextureDimension2D
            return typeof deviceLimit === 'number' && Number.isFinite(deviceLimit)
                ? Math.min(2048, deviceLimit)
                : 2048
        } catch {
            return 2048
        }
    }

    let resizeFrame = 0
    let bufferWidth = 0
    let bufferHeight = 0
    const applyResize = (): void => {
        resizeFrame = 0
        const w = stage.clientWidth
        const h = stage.clientHeight
        // A collapsed flex stage would mean aspect NaN and a zero-size GPU texture
        if (w === 0 || h === 0) return
        camera.aspect = w / h
        camera.updateProjectionMatrix()
        const pixels = planet.pixels.value
        const scale = framingScale(planet, camera.aspect)
        planet.group.scale.setScalar(scale)
        const projectionHeight = pixels * 2 * Math.tan((camera.fov * Math.PI) / 360) / scale
        const largestLayer = Math.max(...planet.metadata.layers.map((layer) => layer.quadScale))
        const desiredHeight = Math.ceil(Math.max(projectionHeight, pixels * largestLayer))
        const desiredWidth = Math.ceil(desiredHeight * camera.aspect)
        const bufferScale = Math.min(1, rendererLimit() / Math.max(desiredWidth, desiredHeight))
        const nextWidth = Math.max(1, Math.floor(desiredWidth * bufferScale))
        const nextHeight = Math.max(1, Math.floor(desiredHeight * bufferScale))
        if (nextWidth !== bufferWidth || nextHeight !== bufferHeight) {
            renderer.setSize(nextWidth, nextHeight, false)
            bufferWidth = nextWidth
            bufferHeight = nextHeight
        }
        background.resize(w, h, pixels)
    }
    const resize = (): void => {
        if (resizeFrame !== 0) return
        resizeFrame = requestAnimationFrame(applyResize)
    }
    new ResizeObserver(resize).observe(stage)
    // Android keyboards resize the visual viewport without always re-firing the observer;
    // re-running layout when the viewport settles un-wedges the stage after keyboard close
    window.visualViewport?.addEventListener('resize', resize)

    canvasStack.appendChild(renderer.domElement)
    applyResize()
    background.update(0, 0)

    const presentFirstFrame = async (candidate: WebGPURenderer): Promise<void> => {
        // compileAsync never settles on Firefox (both backends); treat it as a best-effort
        // warmup with a 3 s budget and rely on render()'s synchronous compile path instead.
        await Promise.race([
            candidate.compileAsync(scene, camera).catch(() => {}),
            new Promise<void>((resolve) => { window.setTimeout(resolve, 3000) }),
        ])
        candidate.render(scene, camera)
        await new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve() }) })
    }

    try {
        await presentFirstFrame(renderer)
        console.info(`First frame presented with ${backendName(renderer)}.`)
    } catch (error: unknown) {
        if (rendererWasForced) throw error
        console.info('First WebGPU frame failed or stalled; rebuilding with forced WebGL.', error)
        renderer.dispose()
        canvas.remove()
        disposePlanet(planet)
        planet = createPlanet('Islands', seed)
        scene.add(planet.group)
        renderer = await initializeForcedWebGL()
        rendererWasForced = true
        configureRenderer(renderer)
        canvas = renderer.domElement
        canvasStack.appendChild(canvas)
        bufferWidth = 0
        bufferHeight = 0
        applyResize()
        await presentFirstFrame(renderer)
        console.info('First frame presented with forced WebGL after WebGPU first-frame failure.')
    }
    $('stage-placeholder').remove()

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
    }

    // Each layer scrolls the shared phase at its own Godot-derived rate, so phase is just
    // Godot's seconds and slider 0.1 means 1×: one full surface wrap every 25 seconds.
    let speed = -0.1
    let phase = 0
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
        renderer.setClearColor(0x000000, 0)
        try {
            renderer.render(scene, camera)
        } catch (error: unknown) {
            if (background.mode === 'None') throw error
            console.error('Background rendering failed; continuing with black.', error)
            background.dispose()
            background = safeBackground('None', seed)
            renderer.render(scene, camera)
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
                    renderer = initialized.renderer
                    rendererWasForced = initialized.forced
                    configureRenderer(renderer)
                    installDeviceLossHandler()
                    bufferWidth = 0
                    bufferHeight = 0
                    resize()
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
    typeSelect.value = 'Islands'
    const backgroundSelect = $<HTMLSelectElement>('background-mode')
    backgroundSelect.value = background.mode
    writeBackgroundToUrl(background.mode)

    backgroundSelect.addEventListener('change', () => {
        const outgoing = background
        background = safeBackground(backgroundSelect.value as BackgroundMode, seed)
        outgoing.dispose()
        background.resize(stage.clientWidth, stage.clientHeight, planet.pixels.value)
        writeBackgroundToUrl(background.mode)
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

    const syncFraming = (): void => {
        planet.group.scale.setScalar(framingScale(planet, camera.aspect))
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
        planet.pixels.value = Number(pixelsNumber.value)
        planet.rotation.value = Number(tiltInput.value)
        syncFraming()
        syncDither()
        syncLayers()
        activeSwatch = 0
        syncPalette()
        resize()
    }

    typeSelect.addEventListener('change', () => {
        const outgoing = planet
        planet = createPlanet(typeSelect.value, seed)
        scene.add(planet.group)
        disposePlanet(outgoing)
        syncPlanetControls()
    })

    $('seed-reroll').addEventListener('click', () => {
        seed = Math.floor(Math.random() * 1_000_000)
        planet.reseed(seed)
        background.reseed(seed)
        writeSeedToUrl(seed)
        seedInput.value = String(seed)
        syncPalette()
    })

    const applySeedInput = (): void => {
        const next = Number.parseInt(seedInput.value, 10)
        if (!Number.isFinite(next)) {
            seedInput.value = String(seed)
            return
        }
        seed = next
        seedInput.value = String(seed)
        planet.reseed(seed)
        background.reseed(seed)
        writeSeedToUrl(seed)
        syncPalette()
    }
    seedInput.addEventListener('change', applySeedInput)

    const clampPixels = (value: number): number => Math.max(12, Math.min(2048, Math.round(value)))
    const syncPixels = (source: HTMLInputElement): void => {
        const pixels = clampPixels(Number(source.value))
        pixelsInput.value = String(pixels)
        pixelsNumber.value = String(pixels)
        planet.pixels.value = pixels
        resize()
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
}

init().catch((err: unknown) => {
    // The placeholder is gone once the canvas mounts; never let this handler throw!
    const placeholder = document.getElementById('stage-placeholder')
    if (placeholder) placeholder.textContent = 'renderer failed to start, check the console'
    console.error(err)
})
