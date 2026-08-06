import { LinearSRGBColorSpace, PerspectiveCamera, Scene, WebGPURenderer } from 'three/webgpu'
import { LAND_PHASE_PER_QUAD, createIslands, reseedIslands, updateIslandsTime } from './tsl/planets/islands'

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

async function init(): Promise<void> {
    const stage = $('stage')
    let seed = seedFromUrl()
    writeSeedToUrl(seed)
    $('seed-value').textContent = String(seed)

    const renderer = new WebGPURenderer({ antialias: false })
    await renderer.init()
    // Legacy r139 wrote gl_FragColor straight to canvas; linear output matches the look
    renderer.outputColorSpace = LinearSRGBColorSpace
    renderer.setPixelRatio(window.devicePixelRatio)

    const scene = new Scene()
    const camera = new PerspectiveCamera(75, 1, 0.1, 100000)
    camera.position.z = 1

    const { group, uniforms } = createIslands(seed)
    scene.add(group)

    const resize = (): void => {
        const w = stage.clientWidth
        const h = stage.clientHeight
        // A collapsed flex stage would mean aspect NaN and a zero-size GPU texture
        if (w === 0 || h === 0) return
        renderer.setSize(w, h)
        camera.aspect = w / h
        camera.updateProjectionMatrix()
    }
    new ResizeObserver(resize).observe(stage)

    $('stage-placeholder').remove()
    stage.appendChild(renderer.domElement)
    resize()

    // Drag does two things depending on where it starts: off the disc it moves the light like
    // the Godot original, on the disc it spins the planet. Mode locks at pointerdown.
    const canvas = renderer.domElement
    canvas.style.touchAction = 'none'
    // Past 1.1 from disc center every pixel clears light_border_2 and the planet goes flat
    // black; 0.85 keeps a lit crescent no matter how far the drag wanders.
    const LIGHT_REACH = 0.85
    // Scrubbed against the land layer, which is the thing the eye tracks. Negative because
    // advancing time slides the surface against the drag, not with it.
    const SCRUB_PER_UV = -LAND_PHASE_PER_QUAD
    const MOMENTUM_TAU = 0.5
    // A flick faster than 20 quad widths/second is a glitchy sample, not an intent
    const MAX_FLICK = 20 * Math.abs(SCRUB_PER_UV)

    // The quad is 1 unit tall at the camera's unit distance, so its on-screen side is the view
    // height there. Screen y-down matches the shaders' Godot UV space, so no flip anywhere.
    const quadUvFromPointer = (e: PointerEvent): { x: number, y: number } | null => {
        const rect = canvas.getBoundingClientRect()
        if (rect.height === 0) return null
        const quadPx = rect.height / (2 * Math.tan((camera.fov * Math.PI) / 360))
        return {
            x: (e.clientX - (rect.left + rect.width / 2)) / quadPx + 0.5,
            y: (e.clientY - (rect.top + rect.height / 2)) / quadPx + 0.5,
        }
    }

    const setLight = (uv: { x: number, y: number }): void => {
        const dx = uv.x - 0.5
        const dy = uv.y - 0.5
        const d = Math.hypot(dx, dy)
        if (d > LIGHT_REACH) {
            uniforms.lightOrigin.value.set(0.5 + (dx / d) * LIGHT_REACH, 0.5 + (dy / d) * LIGHT_REACH)
        } else {
            uniforms.lightOrigin.value.set(uv.x, uv.y)
        }
    }

    // Each layer scrolls the shared phase at its own Godot-derived rate, so phase is just
    // Godot's seconds and slider 0.1 means 1×: one full surface wrap every 25 seconds.
    let speed = 0.1
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
            dragMode = 'light'
            setLight(uv)
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
        phase += dPhase
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
        // Positive baseline like Godot's time += delta (slider 0.1 = 1×, surface drifts
        // left); flick momentum rides on top and decays back to the baseline.
        phase += dt * (momentum + speed / 0.1)
        if (momentum !== 0) {
            momentum *= Math.exp(-dt / MOMENTUM_TAU)
            if (Math.abs(momentum) < 1) momentum = 0
        }
        updateIslandsTime(uniforms, phase)
        renderer.render(scene, camera)
    }

    const syncAnimationLoop = (): void => {
        renderer.setAnimationLoop(document.hidden ? null : animate)
        if (!document.hidden) {
            last = -1
            fpsFrames = 0
            fpsSince = -1
        }
    }
    document.addEventListener('visibilitychange', syncAnimationLoop)
    syncAnimationLoop()

    // Controls
    const typeSelect = $<HTMLSelectElement>('planet-type')
    for (const option of typeSelect.options) {
        option.disabled = option.value !== 'Islands'
    }
    typeSelect.value = 'Islands'

    $('seed-reroll').addEventListener('click', () => {
        seed = Math.floor(Math.random() * 1_000_000)
        reseedIslands(uniforms, seed)
        writeSeedToUrl(seed)
        $('seed-value').textContent = String(seed)
    })

    const pixelsInput = $<HTMLInputElement>('pixels')
    const syncPixels = (): void => {
        uniforms.pixels.value = Number(pixelsInput.value)
        $('pixels-value').textContent = pixelsInput.value
    }
    pixelsInput.addEventListener('input', syncPixels)
    syncPixels()

    $('pixel-presets').addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-px]')
        if (!btn?.dataset['px']) return
        pixelsInput.value = btn.dataset['px']
        syncPixels()
    })

    // Both signed sliders fill from the center out; --frac drives that gradient
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
    const tiltInput = $<HTMLInputElement>('tilt')
    const syncTilt = (): void => {
        uniforms.rotation.value = Number(tiltInput.value)
        $('tilt-value').textContent = tiltInput.value
        setCenterFill(tiltInput)
    }
    tiltInput.addEventListener('input', syncTilt)
    syncTilt()
}

init().catch((err: unknown) => {
    // The placeholder is gone once the canvas mounts; never let this handler throw!
    const placeholder = document.getElementById('stage-placeholder')
    if (placeholder) placeholder.textContent = 'renderer failed to start, check the console'
    console.error(err)
})
