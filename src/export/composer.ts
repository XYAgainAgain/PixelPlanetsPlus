import { DragDropManager, Draggable, Droppable, Feedback, PointerSensor, type DragMoveEvent } from '@dnd-kit/dom'
import { exportGif } from './gif'
import { createBackdropRasterizer } from './backdrop'
import {
    canvasPixelsToComposerBody,
    composerBodyToCanvasPixels,
    nudgeNormalizedCenter,
    snapBodySizeToIntegerScale,
} from './layout'
import { exportCompositePng } from './png'
import { preflightRenderRequest, type PreflightLimits } from './preflight'
import { validateSceneRecipe } from './recipe'
import { bodyLocalToLightUv, createExportSession, lightUvToBodyLocal, type ExportFrame } from './runtime'
import { exportScenePackage } from './scenePackage'
import { exportPngSequence } from './sequence'
import { exportSpritesheet } from './spritesheet'
import { loopsSeamlessly, generatePhaseSamples } from './timing'
import { acquireExportSaveTarget, saveExportFile } from './download'
import { uniquePhases, type AnimatedExportRunOptions } from './animated'
import type { ExportBackend, ExportRunner } from './contract'
import type { BackdropV1, ExportFormat, ExportScale, PlaybackDirection, RenderProgress, RenderRequest, SceneRecipeV1, Vec2 } from './types'
import { PLANETS } from '../tsl/values'

type ComposerFormat = 'png' | 'gif' | 'spritesheet'

export interface ComposerOptions {
    stage: HTMLElement
    backend: () => ExportBackend
    textureLimit: () => number
    currentRecipe: () => SceneRecipeV1
    onRecipeChange: (recipe: SceneRecipeV1) => void
    onClose: (recipe: SceneRecipeV1, changed: boolean) => void
}

export interface SceneComposer {
    open: (format: ComposerFormat) => void
    recipe: () => SceneRecipeV1
    replaceRecipe: (recipe: SceneRecipeV1) => void
    refreshFromLive: () => void
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const element = document.getElementById(id)
    if (!element) throw new Error(`missing #${id}`)
    return element as T
}

// Wire precision is four decimals, so showing more just makes the field look broken.
const trimmed = (value: number): string => String(Number(value.toFixed(4)))

const numberValue = (id: string): number => Number($<HTMLInputElement>(id).value)
const integerValue = (id: string, minimum: number): number => Math.max(minimum, Math.round(numberValue(id)))
const setHidden = (element: HTMLElement, hidden: boolean): void => { element.hidden = hidden }
const clampBodyLocalLight = (light: Vec2): Vec2 => {
    const local = lightUvToBodyLocal(bodyLocalToLightUv(light))
    const distance = Math.hypot(...local)
    if (distance <= 0.85) return local
    const scale = 0.85 / distance
    return [local[0] * scale, local[1] * scale]
}
const previewBackdrop = async (context: CanvasRenderingContext2D, recipe: SceneRecipeV1): Promise<void> => {
    const { width, height } = context.canvas
    const pixels = (await createBackdropRasterizer(recipe.backdrop, width, height)).renderBand(0, height)
    context.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0)
}

// Pipeline internals carry technical text on error.cause; only vetted plain messages reach the panel.
const visitorMessage = (error: unknown, fallback: string): string => {
    const message = error instanceof Error ? error.message : ''
    return message && !(error instanceof Error && 'details' in error) ? message : fallback
}

const frameCanvas = (frame: ExportFrame): HTMLCanvasElement => {
    const canvas = document.createElement('canvas')
    canvas.width = frame.width
    canvas.height = frame.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas 2D is unavailable.')
    context.putImageData(new ImageData(new Uint8ClampedArray(frame.pixels), frame.width, frame.height), 0, 0)
    return canvas
}

export const createSceneComposer = (options: ComposerOptions): SceneComposer => {
    const workspace = $('export-workspace')
    const panel = $('control-panel')
    const canvas = $<HTMLCanvasElement>('export-preview')
    const bodyHandle = $<HTMLButtonElement>('export-body-handle')
    const lightHandle = $<HTMLButtonElement>('export-light-handle')
    const form = $<HTMLFormElement>('export-form')
    const errorOutput = $('export-error')
    const admissionOutput = $('export-admission-message')
    const statusOutput = $('export-status')
    const progressWrap = $('export-progress-wrap')
    const progress = $<HTMLProgressElement>('export-progress')
    const progressValue = $<HTMLOutputElement>('export-progress-value')
    const progressLabel = $('export-progress-label')
    const download = $<HTMLButtonElement>('export-download')
    const cancel = $<HTMLButtonElement>('export-cancel')
    const scaleSelect = $<HTMLSelectElement>('export-scale')
    const formatButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.export-format-button'))
    panel.appendChild(form)
    let state = validateSceneRecipe(options.currentRecipe())
    let format: ComposerFormat = 'png'
    let previewTimer = 0
    let previewGeneration = 0
    let previewWork = Promise.resolve()
    let previewController: AbortController | null = null
    let previewSession: Awaited<ReturnType<typeof createExportSession>> | null = null
    let previewStructure = ''
    let previewBody: HTMLCanvasElement | null = null
    let previewBackdropCanvas: HTMLCanvasElement | null = null
    let previewBackdropKey = ''
    let changedSinceOpen = false
    let controller: AbortController | null = null
    let requestCounter = 0
    const dragManager = new DragDropManager({ sensors: [PointerSensor] })
    const feedback = [Feedback.configure({ feedback: 'none' })]
    const previewDrop = new Droppable({ id: 'export-preview-drop', element: canvas, accept: 'composer-handle' }, dragManager)
    new Draggable({ id: 'export-body-drag', element: bodyHandle, type: 'composer-handle', plugins: feedback }, dragManager)
    new Draggable({ id: 'export-light-drag', element: lightHandle, type: 'composer-handle', plugins: feedback }, dragManager)
    let dragStartBody: ReturnType<typeof composerBodyToCanvasPixels> | null = null
    let dragRecipe: SceneRecipeV1 | null = null

    const backdropFromControls = (): BackdropV1 => {
        const kind = $<HTMLSelectElement>('export-background').value
        if (kind === 'transparent') return { kind }
        if (kind === 'matte') return { kind: 'solid', color: $<HTMLInputElement>('export-matte-color').value }
        return {
            kind: kind as 'stars' | 'gradient' | 'stars-gradient',
            seed: integerValue('export-background-seed', 0),
            density: numberValue('export-star-density'),
            brightness: numberValue('export-star-brightness'),
            starScale: numberValue('export-star-scale'),
            specialStarMix: numberValue('export-special-stars'),
            gradientPhase: numberValue('export-gradient-phase'),
        }
    }

    const recipeFromControls = (): SceneRecipeV1 => validateSceneRecipe({
        ...state,
        canvas: { width: integerValue('export-width', 1), height: integerValue('export-height', 1) },
        body: {
            ...state.body,
            center: [numberValue('export-body-x'), numberValue('export-body-y')],
            size: numberValue('export-body-scale'),
            phase: format === 'png' ? numberValue('export-phase') : numberValue('export-preview-phase'),
        },
        backdrop: format !== 'png' && $<HTMLSelectElement>('export-animation-background').value === 'transparent'
            ? { kind: 'transparent' }
            : backdropFromControls(),
        export: {
            scale: Number(scaleSelect.value) as ExportScale,
            frameCount: format === 'gif'
                ? Math.max(1, Math.round(numberValue('export-fps') * numberValue('export-duration')))
                : integerValue('export-frames', 1),
            columns: integerValue('export-columns', 1),
            margin: integerValue('export-margin', 0),
            startPhase: numberValue('export-start-phase'),
            endPhase: numberValue('export-end-phase'),
            direction: $<HTMLSelectElement>('export-direction').value,
            framesPerSecond: integerValue('export-fps', 1),
        },
    })

    const updateLoopWarning = (): void => {
        const direction = $<HTMLSelectElement>('export-direction').value as PlaybackDirection
        setHidden($('export-loop-warning'), loopsSeamlessly(
            numberValue('export-start-phase'), numberValue('export-end-phase'), direction,
        ))
    }

    const syncControls = (): void => {
        $<HTMLInputElement>('export-width').value = String(state.canvas.width)
        $<HTMLInputElement>('export-height').value = String(state.canvas.height)
        $<HTMLInputElement>('export-body-x').value = trimmed(state.body.center[0])
        $<HTMLInputElement>('export-body-y').value = trimmed(state.body.center[1])
        $<HTMLInputElement>('export-body-scale').value = trimmed(state.body.size)
        $<HTMLInputElement>('export-phase').value = trimmed(state.body.phase)
        $<HTMLInputElement>('export-preview-phase').value = trimmed(state.body.phase)
        $<HTMLInputElement>('export-start-phase').value = String(state.export.startPhase)
        $<HTMLInputElement>('export-end-phase').value = String(state.export.endPhase)
        $<HTMLSelectElement>('export-direction').value = state.export.direction
        scaleSelect.value = String(state.export.scale)
        $<HTMLInputElement>('export-frames').value = String(state.export.frameCount)
        $<HTMLInputElement>('export-columns').value = String(state.export.columns)
        $<HTMLInputElement>('export-margin').value = String(state.export.margin)
        $<HTMLInputElement>('export-fps').value = String(state.export.framesPerSecond)
        $<HTMLInputElement>('export-duration').value = String(state.export.frameCount / state.export.framesPerSecond)
        const backdrop = state.backdrop
        $<HTMLSelectElement>('export-background').value = backdrop.kind === 'solid' ? 'matte' : backdrop.kind
        if (backdrop.kind === 'solid') $<HTMLInputElement>('export-matte-color').value = backdrop.color
        if (backdrop.kind !== 'transparent' && backdrop.kind !== 'solid') {
            $<HTMLInputElement>('export-background-seed').value = String(backdrop.seed)
            $<HTMLInputElement>('export-star-density').value = String(backdrop.density)
            $<HTMLInputElement>('export-star-brightness').value = String(backdrop.brightness)
            $<HTMLInputElement>('export-star-scale').value = String(backdrop.starScale)
            $<HTMLInputElement>('export-special-stars').value = String(backdrop.specialStarMix)
            $<HTMLInputElement>('export-gradient-phase').value = String(backdrop.gradientPhase)
        }
        updateLoopWarning()
    }

    const requestFor = (candidateFormat: ExportFormat, recipe: SceneRecipeV1, scale?: ExportScale): RenderRequest => ({
        id: `${recipe.celestialType}-${recipe.seed}-${++requestCounter}`,
        recipe: { ...recipe, export: { ...recipe.export, scale: scale ?? recipe.export.scale } },
        format: candidateFormat,
        includeMetadata: candidateFormat === 'spritesheet' || candidateFormat === 'png-sequence',
        includeLayers: $<HTMLInputElement>('export-layer-passes').checked,
    })

    const preflightRequestFor = (candidateFormat: ExportFormat, recipe: SceneRecipeV1, scale?: ExportScale): RenderRequest => {
        const request = requestFor(candidateFormat, recipe, scale)
        if (candidateFormat !== 'spritesheet') return request
        const frameCount = uniquePhases(request).length
        return frameCount === recipe.export.frameCount ? request : {
            ...request,
            recipe: { ...request.recipe, export: { ...request.recipe.export, frameCount } },
        }
    }

    const limits = (): PreflightLimits => {
        const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
        return {
            maxTextureDimension2D: options.textureLimit(),
            maxWorkingBytes: deviceMemory ? deviceMemory * 1024 ** 3 * 0.25 : 512 * 1024 ** 2,
            maxBlobBytes: 512 * 1024 ** 2,
        }
    }

    const selectedExportFormat = (): ExportFormat => {
        if (format === 'png') return $<HTMLSelectElement>('export-png-output').value === 'scene-package' ? 'scene-package' : 'png'
        if (format === 'gif') return 'gif'
        return $<HTMLSelectElement>('export-animation-output').value === 'sequence' ? 'png-sequence' : 'spritesheet'
    }

    // preflight already speaks plain English, so pass its sentence through rather than prefixing our own.
    const admissionMessage = (result: ReturnType<typeof preflightRenderRequest>): string =>
        result.reasons.find((reason) => reason.includes('memory')) ?? result.reasons[0] ?? ''

    const updateAdmission = (candidateRecipe?: SceneRecipeV1): void => {
        let selectedReasons: readonly string[] = []
        const recipe = candidateRecipe ?? recipeFromControls()
        const currentLimits = limits()
        const framesInput = $<HTMLInputElement>('export-frames')
        let timingError = ''
        try {
            generatePhaseSamples(recipe.export.startPhase, recipe.export.endPhase, recipe.export.frameCount, recipe.export.direction)
        } catch (error) {
            timingError = error instanceof Error ? error.message : String(error)
        }
        framesInput.setCustomValidity(timingError)
        if (timingError) selectedReasons = [timingError]
        for (const option of Array.from(scaleSelect.options)) {
            const scale = Number(option.value) as ExportScale
            try {
                const result = preflightRenderRequest(preflightRequestFor(selectedExportFormat(), recipe, scale), currentLimits)
                option.disabled = !result.admitted
                const widthLimited = result.estimate.output.width > currentLimits.maxTextureDimension2D
                const heightLimited = result.estimate.output.height > currentLimits.maxTextureDimension2D
                const dimension = widthLimited ? result.estimate.output.width : result.estimate.output.height
                option.title = result.admitted ? '' : admissionMessage(result)
                if (option.value === scaleSelect.value) {
                    const selectedMessage = widthLimited || heightLimited
                        ? `${option.text} would be ${dimension}px ${widthLimited ? 'wide' : 'high'} – this device tops out at ${currentLimits.maxTextureDimension2D}px.`
                        : option.title
                    selectedReasons = timingError ? [timingError, selectedMessage] : selectedMessage ? [selectedMessage] : []
                }
            } catch (error) {
                option.disabled = true
                option.title = 'This scale is unavailable with the current settings.'
                if (option.value === scaleSelect.value) selectedReasons = timingError ? [timingError, option.title] : [option.title]
            }
        }
        admissionOutput.textContent = selectedReasons[0] ?? ''
        setHidden(admissionOutput, selectedReasons.length === 0)
        download.disabled = selectedReasons.length > 0 || controller !== null
    }

    const drawGuides = (context: CanvasRenderingContext2D, center: Vec2, size: number): void => {
        context.save()
        context.strokeStyle = 'rgba(129,140,248,.85)'
        context.lineWidth = 1
        context.setLineDash([5, 4])
        const xs = [0, context.canvas.width / 2, context.canvas.width]
        const ys = [0, context.canvas.height / 2, context.canvas.height]
        if (xs.some((x) => Math.abs(center[0] - x) < 6 || Math.abs(center[0] - size / 2 - x) < 6 || Math.abs(center[0] + size / 2 - x) < 6)) {
            context.beginPath(); context.moveTo(context.canvas.width / 2, 0); context.lineTo(context.canvas.width / 2, context.canvas.height); context.stroke()
        }
        if (ys.some((y) => Math.abs(center[1] - y) < 6 || Math.abs(center[1] - size / 2 - y) < 6 || Math.abs(center[1] + size / 2 - y) < 6)) {
            context.beginPath(); context.moveTo(0, context.canvas.height / 2); context.lineTo(context.canvas.width, context.canvas.height / 2); context.stroke()
        }
        context.restore()
    }

    // Fit the export frame inside the stage in JS: sizing the canvas from its own box would feed back on itself.
    const sizePreviewCanvas = (): void => {
        const stageBox = $('export-preview-stage').getBoundingClientRect()
        const aspect = state.canvas.width / state.canvas.height
        let width = stageBox.width
        let height = width / aspect
        if (height > stageBox.height) {
            height = stageBox.height
            width = height * aspect
        }
        canvas.style.inlineSize = `${width}px`
        canvas.style.blockSize = `${height}px`
        canvas.width = Math.max(1, Math.round(width))
        canvas.height = Math.max(1, Math.round(height))
        previewDrop.refreshShape()
    }

    const positionHandles = (recipe: SceneRecipeV1): void => {
        const body = composerBodyToCanvasPixels(recipe.body, canvas.width, canvas.height)
        const bounds = canvas.getBoundingClientRect()
        const scaleX = bounds.width / canvas.width
        const scaleY = bounds.height / canvas.height
        bodyHandle.style.left = `${canvas.offsetLeft + body.center[0] * scaleX}px`
        bodyHandle.style.top = `${canvas.offsetTop + body.center[1] * scaleY}px`
        bodyHandle.style.setProperty('--export-body-handle-size', `${Math.min(36, body.size * Math.min(scaleX, scaleY) * 0.5)}px`)
        lightHandle.hidden = body.light === null
        if (body.light) {
            lightHandle.style.left = `${canvas.offsetLeft + body.light[0] * scaleX}px`
            lightHandle.style.top = `${canvas.offsetTop + body.light[1] * scaleY}px`
        }
    }

    const resetHandleTransform = (handle: HTMLElement): void => {
        handle.style.setProperty('--export-drag-x', '0px')
        handle.style.setProperty('--export-drag-y', '0px')
    }

    const drawPreview = (recipe: SceneRecipeV1, positionOverlay = true): void => {
        const context = canvas.getContext('2d')
        if (!context) return
        context.imageSmoothingEnabled = false
        const backdropKey = JSON.stringify([canvas.width, canvas.height, recipe.backdrop])
        if (backdropKey !== previewBackdropKey) {
            previewBackdropCanvas = document.createElement('canvas')
            previewBackdropCanvas.width = canvas.width
            previewBackdropCanvas.height = canvas.height
            const backdropContext = previewBackdropCanvas.getContext('2d')
            if (backdropContext) {
                void previewBackdrop(backdropContext, recipe).then(() => {
                    if (previewBackdropKey === backdropKey && !workspace.hidden) drawPreview(recipe)
                }).catch(() => {
                    if (previewBackdropKey !== backdropKey || workspace.hidden) return
                    previewBackdropCanvas = null
                    errorOutput.textContent = 'The preview background could not load. Check your connection, then try again.'
                    setHidden(errorOutput, false)
                })
            }
            previewBackdropKey = backdropKey
        }
        context.clearRect(0, 0, canvas.width, canvas.height)
        if (previewBackdropCanvas) context.drawImage(previewBackdropCanvas, 0, 0)
        const body = composerBodyToCanvasPixels(recipe.body, canvas.width, canvas.height)
        if (previewBody) context.drawImage(previewBody, body.center[0] - body.size / 2, body.center[1] - body.size / 2, body.size, body.size)
        drawGuides(context, body.center, body.size)
        if (body.light) {
            context.fillStyle = '#facc15'
            context.beginPath(); context.arc(body.light[0], body.light[1], 5, 0, Math.PI * 2); context.fill()
        }
        if (positionOverlay) positionHandles(recipe)
    }

    const renderPreview = async (): Promise<void> => {
        if (workspace.hidden) return
        const generation = ++previewGeneration
        previewController?.abort(new DOMException('The preview was superseded.', 'AbortError'))
        const previewAbort = new AbortController()
        previewController = previewAbort
        let recipe: SceneRecipeV1
        try {
            recipe = recipeFromControls()
            state = recipe
            options.onRecipeChange(recipe)
            updateAdmission(recipe)
        } catch (error) {
            errorOutput.textContent = visitorMessage(error, 'Those settings do not work together. Try adjusting them.')
            setHidden(errorOutput, false)
            download.disabled = true
            return
        }
        setHidden(errorOutput, true)
        sizePreviewCanvas()
        try {
            const structure = JSON.stringify({
                backend: options.backend(),
                celestialType: recipe.celestialType, seed: recipe.seed, pixels: recipe.pixels,
                palette: recipe.palette, layers: recipe.layers, dither: recipe.dither,
            })
            if (structure !== previewStructure) {
                previewSession?.dispose()
                previewSession = null
                previewStructure = structure
            }
            if (!previewSession) {
                if (previewAbort.signal.aborted || generation !== previewGeneration) return
                previewSession = await createExportSession(recipe, options.backend(), { signal: previewAbort.signal })
                if (previewAbort.signal.aborted || generation !== previewGeneration) {
                    previewSession.dispose()
                    previewSession = null
                    return
                }
            }
            Object.assign(previewSession.recipe.body, recipe.body)
            const frame = await previewSession.renderFrame(recipe.body.phase, {
                requestId: 'preview', signal: previewAbort.signal,
            })
            if (previewAbort.signal.aborted || generation !== previewGeneration) return
            previewBody = frameCanvas(frame)
            drawPreview(recipe)
        } catch (error) {
            if (!previewAbort.signal.aborted && generation === previewGeneration) {
                errorOutput.textContent = visitorMessage(error, 'The preview could not be drawn. Try different settings.')
                setHidden(errorOutput, false)
            }
        }
    }

    const schedulePreview = (): void => {
        previewController?.abort(new DOMException('The preview was superseded.', 'AbortError'))
        window.clearTimeout(previewTimer)
        previewTimer = window.setTimeout(() => {
            if (workspace.hidden) return
            previewWork = previewWork.then(renderPreview, renderPreview)
        }, 80)
    }

    const setProgress = (event: RenderProgress): void => {
        const ratio = event.total === 0 ? 0 : event.completed / event.total
        progress.value = ratio * 100
        progressValue.value = `${Math.round(ratio * 100)}%`
        progressLabel.textContent = `${event.stage[0]!.toUpperCase()}${event.stage.slice(1)}…`
    }

    const open = (nextFormat: ComposerFormat): void => {
        format = nextFormat
        for (const button of formatButtons) button.setAttribute('aria-pressed', String(button.dataset.exportFormat === format))
        state = validateSceneRecipe(options.currentRecipe())
        changedSinceOpen = false
        syncControls()
        setHidden(workspace, false)
        setHidden(form, false)
        setHidden($('export-static-controls'), format !== 'png')
        setHidden($('export-animated-controls'), format === 'png')
        setHidden($('export-gif-controls'), format !== 'gif')
        setHidden($('export-spritesheet-controls'), format !== 'spritesheet')
        $('export-title').textContent = format === 'png' ? 'PNG Export Editor' : format === 'gif' ? 'Animated GIF' : 'Spritesheet'
        download.textContent = format === 'png' ? 'Download PNG' : format === 'gif' ? 'Download GIF' : 'Download Spritesheet'
        options.stage.classList.add('export-active')
        panel.classList.add('export-active')
        updateLoopWarning()
        schedulePreview()
    }

    form.addEventListener('input', (event) => {
        changedSinceOpen = true
        updateLoopWarning()
        updateAdmission()
        const target = event.target as HTMLElement
        if (!['export-phase', 'export-preview-phase'].includes(target.id) && previewBody) {
            state = recipeFromControls()
            options.onRecipeChange(state)
            if (target.id === 'export-width' || target.id === 'export-height') sizePreviewCanvas()
            drawPreview(state)
        } else schedulePreview()
    })
    form.addEventListener('change', () => { updateAdmission() })
    form.addEventListener('submit', (event) => {
        event.preventDefault()
        if (controller) return
        void (async () => {
            const activeController = new AbortController()
            controller = activeController
            download.disabled = true
            setHidden(cancel, false)
            setHidden(progressWrap, false)
            setHidden(errorOutput, true)
            statusOutput.textContent = 'Preparing export…'
            try {
                const exportFormat = selectedExportFormat()
                const recipe = recipeFromControls()
                const request = requestFor(exportFormat, recipe)
                const extension = exportFormat === 'png' ? 'png' : exportFormat === 'gif' ? 'gif' : 'zip'
                const mediaType = extension === 'png' ? 'image/png' : extension === 'gif' ? 'image/gif' : 'application/zip'
                const baseName = exportFormat === 'png' ? `${recipe.celestialType}-${recipe.seed}`
                    : exportFormat === 'scene-package' ? `${recipe.celestialType}-scene`
                        : `${recipe.celestialType}-${recipe.seed}`
                const saveTarget = await acquireExportSaveTarget(`${baseName}.${extension}`, mediaType)
                if (activeController.signal.aborted) throw activeController.signal.reason
                const runners: Record<ExportFormat, ExportRunner> = {
                    png: exportCompositePng,
                    'scene-package': exportScenePackage,
                    gif: exportGif,
                    spritesheet: exportSpritesheet,
                    'png-sequence': exportPngSequence,
                }
                const runOptions: AnimatedExportRunOptions = {
                    backend: options.backend(), signal: activeController.signal, onProgress: setProgress,
                    oneBitTransparency: $<HTMLInputElement>('export-gif-transparency').checked,
                    preflightLimits: limits(),
                }
                const output = await runners[exportFormat](request, runOptions)
                for (const file of output.files) await saveExportFile(file, { signal: activeController.signal }, saveTarget)
                statusOutput.textContent = output.warnings.length ? output.warnings.join(' ') : 'Export saved.'
            } catch (error) {
                if (error instanceof DOMException && error.name === 'AbortError') statusOutput.textContent = 'Export canceled.'
                else {
                    errorOutput.textContent = visitorMessage(error, 'Something went wrong during export. Try again, or try a smaller size.')
                    setHidden(errorOutput, false)
                }
            } finally {
                if (controller === activeController) controller = null
                setHidden(cancel, true)
                setHidden(progressWrap, true)
                updateAdmission()
            }
        })()
    })
    cancel.addEventListener('click', () => { controller?.abort(new DOMException('The export was canceled.', 'AbortError')) })
    $('export-close').addEventListener('click', () => {
        const closingRecipe = recipeFromControls()
        controller?.abort(new DOMException('The export was canceled.', 'AbortError'))
        previewController?.abort(new DOMException('The preview was closed.', 'AbortError'))
        previewController = null
        window.clearTimeout(previewTimer)
        previewTimer = 0
        previewSession?.dispose()
        previewSession = null
        previewStructure = ''
        previewBody = null
        setHidden(workspace, true)
        setHidden(form, true)
        options.stage.classList.remove('export-active')
        panel.classList.remove('export-active')
        options.onClose(closingRecipe, changedSinceOpen)
    })
    $('export-background-reroll').addEventListener('click', () => {
        changedSinceOpen = true
        $<HTMLInputElement>('export-background-seed').value = String(Math.floor(Math.random() * 1_000_000))
        schedulePreview()
    })
    $<HTMLSelectElement>('export-size-preset').addEventListener('change', (event) => {
        changedSinceOpen = true
        const value = (event.currentTarget as HTMLSelectElement).value
        if (value === 'viewport') {
            const aspect = options.stage.clientWidth / Math.max(1, options.stage.clientHeight)
            const width = aspect >= 1 ? 1920 : Math.round(1920 * aspect)
            const height = aspect >= 1 ? Math.round(1920 / aspect) : 1920
            $<HTMLInputElement>('export-width').value = String(width)
            $<HTMLInputElement>('export-height').value = String(height)
        } else if (value !== 'custom') {
            const [width, height] = value.split('x')
            $<HTMLInputElement>('export-width').value = width!
            $<HTMLInputElement>('export-height').value = height!
        }
        schedulePreview()
    })

    const dragBodyAt = (event: Pick<DragMoveEvent, 'operation'>): ReturnType<typeof composerBodyToCanvasPixels> | null => {
        if (!dragStartBody || !dragRecipe || !event.operation.source) return null
        const bounds = canvas.getBoundingClientRect()
        const delta: Vec2 = [
            event.operation.transform.x * canvas.width / bounds.width,
            event.operation.transform.y * canvas.height / bounds.height,
        ]
        if (event.operation.source.id === 'export-body-drag') {
            return {
                ...dragStartBody,
                center: [dragStartBody.center[0] + delta[0], dragStartBody.center[1] + delta[1]],
                light: dragStartBody.light
                    ? [dragStartBody.light[0] + delta[0], dragStartBody.light[1] + delta[1]]
                    : null,
            }
        }
        return {
            ...dragStartBody,
            light: dragStartBody.light
                ? [dragStartBody.light[0] + delta[0], dragStartBody.light[1] + delta[1]]
                : null,
        }
    }

    dragManager.monitor.addEventListener('dragstart', (event) => {
        if (!event.operation.source) return
        dragRecipe = recipeFromControls()
        dragStartBody = composerBodyToCanvasPixels(dragRecipe.body, canvas.width, canvas.height)
    })
    dragManager.monitor.addEventListener('dragmove', (event) => {
        const body = dragBodyAt(event)
        if (!body || !dragRecipe || !event.operation.source) return
        const bounds = canvas.getBoundingClientRect()
        const sourceIsBody = event.operation.source.id === 'export-body-drag'
        const handle = sourceIsBody ? bodyHandle : lightHandle
        if (sourceIsBody && !lightHandle.hidden) {
            lightHandle.style.setProperty('--export-drag-x', `${event.operation.transform.x}px`)
            lightHandle.style.setProperty('--export-drag-y', `${event.operation.transform.y}px`)
        }
        const normalized = canvasPixelsToComposerBody(body, canvas.width, canvas.height)
        if (!sourceIsBody && normalized.light) normalized.light = clampBodyLocalLight(normalized.light)
        const previewBodyPixels = composerBodyToCanvasPixels(normalized, canvas.width, canvas.height)
        const dragX = sourceIsBody ? event.operation.transform.x
            : (previewBodyPixels.light![0] - dragStartBody!.light![0]) * bounds.width / canvas.width
        const dragY = sourceIsBody ? event.operation.transform.y
            : (previewBodyPixels.light![1] - dragStartBody!.light![1]) * bounds.height / canvas.height
        handle.style.setProperty('--export-drag-x', `${dragX}px`)
        handle.style.setProperty('--export-drag-y', `${dragY}px`)
        drawPreview({ ...dragRecipe, body: { ...dragRecipe.body, ...normalized } }, false)
    })
    dragManager.monitor.addEventListener('dragend', (event) => {
        const body = dragBodyAt(event)
        resetHandleTransform(bodyHandle)
        resetHandleTransform(lightHandle)
        if (!event.canceled && body && dragRecipe) {
            changedSinceOpen = true
            const normalized = canvasPixelsToComposerBody(body, canvas.width, canvas.height)
            if (event.operation.source?.id === 'export-light-drag' && normalized.light) {
                normalized.light = clampBodyLocalLight(normalized.light)
            }
            $<HTMLInputElement>('export-body-x').value = normalized.center[0].toFixed(4)
            $<HTMLInputElement>('export-body-y').value = normalized.center[1].toFixed(4)
            state = { ...dragRecipe, body: { ...dragRecipe.body, ...normalized } }
            options.onRecipeChange(state)
            positionHandles(state)
            schedulePreview()
        } else {
            drawPreview(recipeFromControls())
        }
        dragStartBody = null
        dragRecipe = null
    })

    let resizing = false
    const pointerPosition = (event: PointerEvent): Vec2 => {
        const bounds = canvas.getBoundingClientRect()
        return [(event.clientX - bounds.left) * canvas.width / bounds.width, (event.clientY - bounds.top) * canvas.height / bounds.height]
    }
    canvas.addEventListener('pointerdown', (event) => {
        const body = composerBodyToCanvasPixels(recipeFromControls().body, canvas.width, canvas.height)
        const point = pointerPosition(event)
        const bodyDistance = Math.hypot(point[0] - body.center[0], point[1] - body.center[1])
        resizing = Math.abs(bodyDistance - body.size / 2) < 14
        if (resizing) canvas.setPointerCapture(event.pointerId)
    })
    canvas.addEventListener('pointermove', (event) => {
        if (!resizing) return
        changedSinceOpen = true
        const recipe = recipeFromControls()
        const body = composerBodyToCanvasPixels(recipe.body, canvas.width, canvas.height)
        const point = pointerPosition(event)
        let size = Math.max(1, Math.hypot(point[0] - body.center[0], point[1] - body.center[1]) * 2)
        if ($<HTMLInputElement>('export-snap').checked && !event.altKey) {
            const logical = Math.max(1, Math.round(recipe.pixels * PLANETS[recipe.celestialType].relativeScale))
            const exportSize = size * Math.min(recipe.canvas.width, recipe.canvas.height) / Math.min(canvas.width, canvas.height)
            size = snapBodySizeToIntegerScale(exportSize, logical).size * Math.min(canvas.width, canvas.height)
                / Math.min(recipe.canvas.width, recipe.canvas.height)
        }
        body.size = size
        const normalized = canvasPixelsToComposerBody(body, canvas.width, canvas.height)
        $<HTMLInputElement>('export-body-x').value = normalized.center[0].toFixed(4)
        $<HTMLInputElement>('export-body-y').value = normalized.center[1].toFixed(4)
        $<HTMLInputElement>('export-body-scale').value = normalized.size.toFixed(4)
        state = { ...recipe, body: { ...recipe.body, center: normalized.center, size: normalized.size, light: normalized.light } }
        options.onRecipeChange(state)
        drawPreview(state)
    })
    const endDrag = (): void => {
        if (!resizing) return
        resizing = false
        schedulePreview()
    }
    canvas.addEventListener('pointerup', endDrag)
    canvas.addEventListener('pointercancel', endDrag)
    canvas.addEventListener('keydown', (event) => {
        const deltas: Partial<Record<string, Vec2>> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
        const delta = deltas[event.key]
        if (!delta) return
        changedSinceOpen = true
        event.preventDefault()
        const multiplier = event.shiftKey ? 10 : 1
        const center = nudgeNormalizedCenter(recipeFromControls().body.center, state.canvas.width, state.canvas.height, delta[0] * multiplier, delta[1] * multiplier)
        $<HTMLInputElement>('export-body-x').value = center[0].toFixed(4)
        $<HTMLInputElement>('export-body-y').value = center[1].toFixed(4)
        schedulePreview()
    })

    const replaceRecipe = (recipe: SceneRecipeV1): void => {
        state = validateSceneRecipe(recipe)
        syncControls()
        if (!workspace.hidden) schedulePreview()
    }

    const refreshFromLive = (): void => {
        if (workspace.hidden) state = validateSceneRecipe(options.currentRecipe())
    }

    new ResizeObserver(() => {
        if (workspace.hidden) return
        sizePreviewCanvas()
        drawPreview(state)
    }).observe(workspace)

    return { open, recipe: () => workspace.hidden ? state : recipeFromControls(), replaceRecipe, refreshFromLive }
}
