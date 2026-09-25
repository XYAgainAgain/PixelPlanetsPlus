import { exportGif } from './gif'
import { createBackdropRasterizer } from './backdrop'
import {
    alphaBounds,
    bodyFrameSize,
    canonicalFrameSize,
    fitCanvasToArt,
    nudgeNormalizedCenter,
    placeBody,
    type ArtBox,
} from './layout'
import {
    CHROMATIC_ABERRATION_MIN_WIDTH,
    applyChromaticAberration,
    chromaticAberrationOffset,
    chromaticAberrationSetting,
    effectiveChromaticAberration,
    hasNoncanonicalChromaticAberration,
    isChromaticAberration,
    withChromaticAberration,
} from './effects'
import { PLANETS } from '../tsl/values'
import { exportCompositePng } from './png'
import { preflightRenderRequest, type PreflightLimits } from './preflight'
import { MAX_FRAMES_PER_SECOND, validateSceneRecipe } from './recipe'
import { bodyLocalToLightUv, createExportSession, lightUvToBodyLocal, type ExportFrame } from './runtime'
import { exportScenePackage } from './scenePackage'
import { exportPngSequence } from './sequence'
import { exportSpritesheet } from './spritesheet'
import { loopsSeamlessly, generatePhaseSamples } from './timing'
import { acquireExportSaveTarget, saveExportFile } from './download'
import { uniquePhases, type AnimatedExportRunOptions } from './animated'
import { exportExtension, exportFilename, exportMediaType } from './filenames'
import type { ExportRunner } from './contract'
import type { GpuHost } from '../gpu'
import type { BackdropBaseV2, BackdropV2, ExportFormat, ExportScale, PlaybackDirection, RenderProgress, RenderRequest, SceneRecipeV2, Vec2 } from './types'

type ComposerFormat = 'png' | 'gif' | 'spritesheet'
type DragKind = 'body' | 'light'

// The body as drawn on the preview canvas, in preview pixels.
interface PreviewGeometry {
    left: number
    top: number
    sizeX: number
    sizeY: number
    scaleX: number
    artCenter: Vec2
    light: Vec2 | null
}

export interface ComposerOptions {
    stage: HTMLElement
    gpu: GpuHost
    currentRecipe: () => SceneRecipeV2
    // The live Chromatic Aberration toggle, which seeds the export checkbox when the recipe has no say.
    liveChromaticAberration: () => boolean
    // Writes the planet's pixel count through to the live control and returns the value it accepted.
    setPixels: (pixels: number) => number
    onRecipeChange: (recipe: SceneRecipeV2) => void
    onClose: (recipe: SceneRecipeV2, changed: boolean) => void
}

export interface SceneComposer {
    open: (format: ComposerFormat) => void
    recipe: () => SceneRecipeV2
    replaceRecipe: (recipe: SceneRecipeV2) => void
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
const LIGHT_LIMIT = 0.85
const SNAP_DISTANCE = 6
// Normalized centers travel at four decimals, so "exactly centered" means within that precision.
const isCentered = (value: number): boolean => Math.abs(value - 0.5) < 5e-5
// Animated previews rasterize the frozen backdrop at the exported frame size up to this edge, like the exporter.
const FROZEN_BACKDROP_PREVIEW_LIMIT = 2048
const TRANSPARENT: BackdropV2 = { base: { kind: 'transparent' }, stars: null }
const clampBodyLocalLight = (light: Vec2): Vec2 => {
    const local = lightUvToBodyLocal(bodyLocalToLightUv(light))
    const distance = Math.hypot(...local)
    if (distance <= LIGHT_LIMIT) return local
    const scale = LIGHT_LIMIT / distance
    return [local[0] * scale, local[1] * scale]
}
const previewBackdrop = async (context: CanvasRenderingContext2D, recipe: SceneRecipeV2): Promise<void> => {
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
    const pixelsInput = $<HTMLInputElement>('export-pixels')
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
    // The art box measured from the latest preview render, keyed by the pose it was measured at.
    let previewArt: { key: string, cells: number, box: ArtBox | null } | null = null
    let fitPending = false
    let relightQueued = false
    let relightWanted = false
    let changedSinceOpen = false
    let controller: AbortController | null = null
    let requestCounter = 0
    let errorSource: 'preview' | 'export' | null = null
    let drag: {
        kind: DragKind
        pointerId: number
        target: HTMLElement
        startClient: Vec2
        startGeometry: PreviewGeometry
        startRecipe: SceneRecipeV2
        moved: boolean
    } | null = null
    const chromaticInput = $<HTMLInputElement>('export-chromatic-aberration')
    const ditherInput = $<HTMLInputElement>('export-dither')
    const chromaticNote = $('export-chromatic-aberration-note')
    const smallImageNote = chromaticNote.textContent ?? ''

    // Preview and export share one alert, so a preview refresh must not clear an export failure.
    const showError = (message: string, source: 'preview' | 'export'): void => {
        errorSource = source
        errorOutput.textContent = message
        setHidden(errorOutput, false)
    }
    const clearError = (source: 'preview' | 'export'): void => {
        if (errorSource !== source) return
        errorSource = null
        setHidden(errorOutput, true)
    }

    const backdropFromControls = (): BackdropV2 => {
        const kind = $<HTMLSelectElement>('export-background').value
        const base: BackdropBaseV2 = kind === 'solid' ? { kind, color: $<HTMLInputElement>('export-matte-color').value }
            : kind === 'gradient' ? { kind, phase: numberValue('export-gradient-phase') }
                : { kind: 'transparent' }
        return {
            base,
            stars: $<HTMLInputElement>('export-stars').checked ? {
                seed: integerValue('export-background-seed', 0),
                density: numberValue('export-star-density'),
                brightness: numberValue('export-star-brightness'),
                starScale: numberValue('export-star-scale'),
                specialStarMix: numberValue('export-special-stars'),
            } : null,
        }
    }

    const recipeFromControls = (): SceneRecipeV2 => {
        const framesPerSecond = Math.min(MAX_FRAMES_PER_SECOND, integerValue('export-fps', 1))
        return validateSceneRecipe({
            ...state,
            // A disabled box shows "off" without erasing the choice, so it defers to the recipe.
            dither: ditherInput.disabled ? state.dither : ditherInput.checked,
            effects: chromaticInput.disabled ? state.effects : withChromaticAberration(state.effects, chromaticInput.checked),
            pixels: Math.max(12, Math.min(2048, integerValue('export-pixels', 12))),
            canvas: { width: integerValue('export-width', 1), height: integerValue('export-height', 1) },
            body: {
                ...state.body,
                center: [numberValue('export-body-x'), numberValue('export-body-y')],
                phase: format === 'png' ? numberValue('export-phase') : numberValue('export-preview-phase'),
            },
            backdrop: backdropFromControls(),
            export: {
                scale: Number(scaleSelect.value) as ExportScale,
                frameCount: format === 'gif'
                    ? Math.max(1, Math.round(framesPerSecond * numberValue('export-duration')))
                    : integerValue('export-frames', 1),
                columns: integerValue('export-columns', 1),
                margin: integerValue('export-margin', 0),
                startPhase: numberValue('export-start-phase'),
                endPhase: numberValue('export-end-phase'),
                direction: $<HTMLSelectElement>('export-direction').value,
                framesPerSecond,
            },
        })
    }

    // Animated formats may drop the backdrop for this export only; the configured one stays in the recipe.
    const exportRecipe = (recipe: SceneRecipeV2): SceneRecipeV2 =>
        format !== 'png' && $<HTMLSelectElement>('export-animation-background').value === 'transparent'
            ? { ...recipe, backdrop: TRANSPARENT }
            : recipe

    const updateBackdropVisibility = (): void => {
        const base = $<HTMLSelectElement>('export-background').value
        setHidden($('export-backdrop-controls'), format !== 'png' && $<HTMLSelectElement>('export-animation-background').value === 'transparent')
        setHidden($('export-matte-field'), base !== 'solid')
        setHidden($('export-gradient-field'), base !== 'gradient')
        setHidden($('export-star-settings'), !$<HTMLInputElement>('export-stars').checked)
    }

    const updateLoopWarning = (): void => {
        const direction = $<HTMLSelectElement>('export-direction').value as PlaybackDirection
        setHidden($('export-loop-warning'), loopsSeamlessly(
            numberValue('export-start-phase'), numberValue('export-end-phase'), direction,
        ))
    }

    const syncBodyFields = (recipe: SceneRecipeV2): void => {
        $<HTMLInputElement>('export-body-x').value = trimmed(recipe.body.center[0])
        $<HTMLInputElement>('export-body-y').value = trimmed(recipe.body.center[1])
    }

    // A recipe that never chose chromatic aberration follows the live toggle, as the export checkbox's default.
    const seedLook = (recipe: SceneRecipeV2): SceneRecipeV2 => recipe.effects.some(isChromaticAberration)
        ? recipe
        : { ...recipe, effects: withChromaticAberration(recipe.effects, options.liveChromaticAberration()) }

    // The width that governs the aberration: the canvas for PNG, the square frame for animated formats.
    const outputWidth = (recipe: SceneRecipeV2): number => format === 'png'
        ? recipe.canvas.width
        : bodyFrameSize(recipe.celestialType, recipe.pixels, recipe.export.scale)

    const syncLookControls = (recipe: SceneRecipeV2): void => {
        ditherInput.disabled = PLANETS[recipe.celestialType].ditherLayers.length === 0
        ditherInput.checked = recipe.dither
        // A noncanonical entry is someone else's data: the box stays off and hands-off rather than rewrite it.
        const foreign = hasNoncanonicalChromaticAberration(recipe.effects)
        const available = !foreign && chromaticAberrationOffset(outputWidth(recipe)) >= 1
        chromaticInput.disabled = !available
        chromaticInput.checked = available && chromaticAberrationSetting(recipe.effects) === true
        chromaticInput.title = available ? '' : foreign
            ? 'This link carries a chromatic aberration setting this version cannot apply, so it is kept as is.'
            : `Needs an image at least ${CHROMATIC_ABERRATION_MIN_WIDTH} px wide.`
        chromaticNote.textContent = foreign ? chromaticInput.title : smallImageNote
        setHidden(chromaticNote, available)
    }

    const syncControls = (): void => {
        pixelsInput.value = String(state.pixels)
        $<HTMLInputElement>('export-width').value = String(state.canvas.width)
        $<HTMLInputElement>('export-height').value = String(state.canvas.height)
        syncBodyFields(state)
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
        const { base, stars } = state.backdrop
        $<HTMLSelectElement>('export-background').value = base.kind
        if (base.kind === 'solid') $<HTMLInputElement>('export-matte-color').value = base.color
        if (base.kind === 'gradient') $<HTMLInputElement>('export-gradient-phase').value = String(base.phase)
        $<HTMLInputElement>('export-stars').checked = stars !== null
        if (stars) {
            $<HTMLInputElement>('export-background-seed').value = String(stars.seed)
            $<HTMLInputElement>('export-star-density').value = String(stars.density)
            $<HTMLInputElement>('export-star-brightness').value = String(stars.brightness)
            $<HTMLInputElement>('export-star-scale').value = String(stars.starScale)
            $<HTMLInputElement>('export-special-stars').value = String(stars.specialStarMix)
        }
        updateBackdropVisibility()
        updateLoopWarning()
        syncLookControls(state)
    }

    const requestFor = (candidateFormat: ExportFormat, recipe: SceneRecipeV2, scale?: ExportScale): RenderRequest => {
        const source = exportRecipe(recipe)
        return {
            id: `${source.celestialType}-${source.seed}-${++requestCounter}`,
            recipe: { ...source, export: { ...source.export, scale: scale ?? source.export.scale } },
            format: candidateFormat,
            includeMetadata: candidateFormat === 'spritesheet' || candidateFormat === 'png-sequence',
            includeLayers: $<HTMLInputElement>('export-layer-passes').checked,
        }
    }

    const preflightRequestFor = (candidateFormat: ExportFormat, recipe: SceneRecipeV2, scale?: ExportScale): RenderRequest => {
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
            maxTextureDimension2D: options.gpu.current().textureLimit,
            maxWorkingBytes: deviceMemory ? deviceMemory * 1024 ** 3 * 0.25 : 512 * 1024 ** 2,
            maxBlobBytes: 512 * 1024 ** 2,
        }
    }

    const selectedExportFormat = (): ExportFormat => {
        if (format === 'png') return $<HTMLSelectElement>('export-png-output').value === 'scene-package' ? 'scene-package' : 'png'
        if (format === 'gif') return 'gif'
        return $<HTMLSelectElement>('export-animation-output').value === 'sequence' ? 'png-sequence' : 'spritesheet'
    }

    // Answers "how big is my planet in the file, and how sharp?" from the same math the exporters use.
    const updateSizeReadout = (recipe: SceneRecipeV2, sheet?: { width: number, height: number }): void => {
        const frame = bodyFrameSize(recipe.celestialType, recipe.pixels, recipe.export.scale)
        const framed = canonicalFrameSize(recipe.celestialType, recipe.pixels) / recipe.pixels
        const label = format === 'png' ? 'Planet in file' : 'Frame in file'
        $('export-size-readout').textContent = format === 'spritesheet' && sheet && selectedExportFormat() === 'spritesheet'
            ? `${label}: ${frame}×${frame} px · sheet ${sheet.width}×${sheet.height} px`
            : `${label}: ${frame}×${frame} px`
        const framing = framed === 1 ? '' : `, framed ${trimmed(Number(framed.toFixed(2)))}× wide for its outer layers`
        const canvasNote = format === 'png' ? ` on a ${recipe.canvas.width}×${recipe.canvas.height} canvas` : ''
        $('export-size-detail').textContent = `${recipe.pixels} px planet${framing}, zoomed ${recipe.export.scale}× with hard pixel edges${canvasNote}.`
        const art = fitCanvasToArt(canonicalFrameSize(recipe.celestialType, recipe.pixels), recipe.export.scale, artFor(recipe))
        setHidden($('export-size-warning'), format !== 'png' || (art.width <= recipe.canvas.width && art.height <= recipe.canvas.height))
    }

    // preflight already speaks plain English, so pass its sentence through rather than prefixing our own.
    const admissionMessage = (result: ReturnType<typeof preflightRenderRequest>): string =>
        result.reasons.find((reason) => reason.includes('memory')) ?? result.reasons[0] ?? ''

    const updateAdmission = (candidateRecipe?: SceneRecipeV2): void => {
        let selectedReasons: readonly string[] = []
        let recipe: SceneRecipeV2
        try {
            recipe = candidateRecipe ?? recipeFromControls()
        } catch (error) {
            admissionOutput.textContent = visitorMessage(error, 'Those settings do not work together. Try adjusting them.')
            setHidden(admissionOutput, false)
            download.disabled = true
            return
        }
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
        let sheet: { width: number, height: number } | undefined
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
                    sheet = result.estimate.output
                    const selectedMessage = format !== 'png' && (widthLimited || heightLimited)
                        ? `${option.text} would be ${dimension}px ${widthLimited ? 'wide' : 'high'}: this device tops out at ${currentLimits.maxTextureDimension2D}px.`
                        : option.title
                    selectedReasons = timingError ? [timingError, selectedMessage] : selectedMessage ? [selectedMessage] : []
                }
            } catch {
                option.disabled = true
                option.title = 'This zoom is unavailable with the current settings.'
                if (option.value === scaleSelect.value) selectedReasons = timingError ? [timingError, option.title] : [option.title]
            }
        }
        updateSizeReadout(recipe, sheet)
        selectedReasons = selectedReasons.filter(Boolean)
        admissionOutput.textContent = selectedReasons[0] ?? ''
        setHidden(admissionOutput, selectedReasons.length === 0)
        download.disabled = selectedReasons.length > 0 || controller !== null
    }

    // Everything that changes the body's silhouette; the light and placement never do.
    const artKey = (recipe: SceneRecipeV2): string => JSON.stringify([
        recipe.celestialType, recipe.seed, recipe.pixels, recipe.layers, recipe.body.phase, recipe.body.rotation,
    ])

    // The newest measured art box for this frame size; a pose change keeps it until the next render lands.
    function artFor(recipe: SceneRecipeV2): ArtBox | null {
        return previewArt?.cells === canonicalFrameSize(recipe.celestialType, recipe.pixels) ? previewArt.box : null
    }

    const previewArtFresh = (recipe: SceneRecipeV2): boolean => previewArt?.key === artKey(recipe)

    // PNG previews its whole canvas; GIF and spritesheet preview exactly their square, always-centered frame.
    const previewFrame = (recipe: SceneRecipeV2): { width: number, height: number } => {
        if (format === 'png') return { width: recipe.canvas.width, height: recipe.canvas.height }
        const size = bodyFrameSize(recipe.celestialType, recipe.pixels, recipe.export.scale)
        return { width: size, height: size }
    }

    /* The body exactly where the exporter puts it, mapped from export to preview pixels. The art center carries
       the handle; the frame center anchors the light, which is body-local to the frame. */
    const previewGeometry = (recipe: SceneRecipeV2): PreviewGeometry => {
        const frame = previewFrame(recipe)
        const cells = canonicalFrameSize(recipe.celestialType, recipe.pixels)
        const scale = recipe.export.scale
        const placement = format === 'png'
            ? placeBody(recipe.body.center, frame.width, frame.height, cells, scale, artFor(recipe))
            : { left: 0, top: 0, size: cells * scale, art: { x: 0, y: 0, width: cells, height: cells } }
        const scaleX = canvas.width / frame.width
        const scaleY = canvas.height / frame.height
        const sizeX = placement.size * scaleX
        const sizeY = placement.size * scaleY
        const frameCenter: Vec2 = [placement.left * scaleX + sizeX / 2, placement.top * scaleY + sizeY / 2]
        return {
            left: placement.left * scaleX, top: placement.top * scaleY, sizeX, sizeY, scaleX,
            artCenter: [
                (placement.left + (placement.art.x + placement.art.width / 2) * scale) * scaleX,
                (placement.top + (placement.art.y + placement.art.height / 2) * scale) * scaleY,
            ],
            light: recipe.body.light && [frameCenter[0] + recipe.body.light[0] * sizeX, frameCenter[1] + recipe.body.light[1] * sizeY],
        }
    }

    const drawGuides = (context: CanvasRenderingContext2D, recipe: SceneRecipeV2): void => {
        context.save()
        context.strokeStyle = 'rgba(129,140,248,.85)'
        context.lineWidth = 1
        context.setLineDash([5, 4])
        const { width, height } = context.canvas
        if (isCentered(recipe.body.center[0])) {
            context.beginPath(); context.moveTo(width / 2, 0); context.lineTo(width / 2, height); context.stroke()
        }
        if (isCentered(recipe.body.center[1])) {
            context.beginPath(); context.moveTo(0, height / 2); context.lineTo(width, height / 2); context.stroke()
        }
        context.restore()
    }

    // Fit the export frame inside the stage in JS: sizing the canvas from its own box would feed back on itself.
    const sizePreviewCanvas = (): void => {
        const stageBox = $('export-preview-stage').getBoundingClientRect()
        const frame = previewFrame(state)
        const aspect = frame.width / frame.height
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
    }

    const positionHandles = (geometry: PreviewGeometry): void => {
        const bounds = canvas.getBoundingClientRect()
        const scaleX = bounds.width / canvas.width
        const scaleY = bounds.height / canvas.height
        bodyHandle.style.left = `${canvas.offsetLeft + geometry.artCenter[0] * scaleX}px`
        bodyHandle.style.top = `${canvas.offsetTop + geometry.artCenter[1] * scaleY}px`
        bodyHandle.style.setProperty('--export-body-handle-size', `${Math.max(16, Math.min(36, geometry.sizeX * scaleX * 0.5))}px`)
        bodyHandle.hidden = format !== 'png'
        lightHandle.hidden = geometry.light === null
        if (geometry.light) {
            lightHandle.style.left = `${canvas.offsetLeft + geometry.light[0] * scaleX}px`
            lightHandle.style.top = `${canvas.offsetTop + geometry.light[1] * scaleY}px`
        }
    }

    const drawPreview = (recipe: SceneRecipeV2): void => {
        const context = canvas.getContext('2d')
        if (!context) return
        context.imageSmoothingEnabled = false
        const shown = exportRecipe(recipe)
        const frame = previewFrame(recipe)
        // Star size and placement follow the raster's dimensions, so animated previews use the exporter's frame size.
        const raster = format !== 'png' && frame.width <= FROZEN_BACKDROP_PREVIEW_LIMIT
            ? { width: frame.width, height: frame.height }
            : { width: canvas.width, height: canvas.height }
        const backdropKey = JSON.stringify([raster.width, raster.height, shown.backdrop])
        if (backdropKey !== previewBackdropKey) {
            const backdropCanvas = document.createElement('canvas')
            backdropCanvas.width = raster.width
            backdropCanvas.height = raster.height
            previewBackdropCanvas = null
            previewBackdropKey = backdropKey
            const backdropContext = backdropCanvas.getContext('2d')
            if (backdropContext) {
                void previewBackdrop(backdropContext, shown).then(() => {
                    if (previewBackdropKey !== backdropKey || workspace.hidden) return
                    previewBackdropCanvas = backdropCanvas
                    drawPreview(state)
                }).catch(() => {
                    if (previewBackdropKey !== backdropKey || workspace.hidden) return
                    showError('The preview background could not load. Check your connection, then try again.', 'preview')
                })
            }
        }
        context.clearRect(0, 0, canvas.width, canvas.height)
        if (previewBackdropCanvas) context.drawImage(previewBackdropCanvas, 0, 0, canvas.width, canvas.height)
        const geometry = previewGeometry(recipe)
        if (previewBody) context.drawImage(previewBody, geometry.left, geometry.top, geometry.sizeX, geometry.sizeY)
        // The exporter's whole-pixel shift, scaled to the preview and never below one preview pixel.
        const aberration = effectiveChromaticAberration(shown, frame.width)
        if (aberration > 0) {
            const image = context.getImageData(0, 0, canvas.width, canvas.height)
            applyChromaticAberration(image.data, canvas.width, canvas.height, Math.max(1, Math.round(aberration * geometry.scaleX)))
            context.putImageData(image, 0, 0)
        }
        if (format === 'png') drawGuides(context, recipe)
        positionHandles(geometry)
    }

    const renderPreview = async (): Promise<void> => {
        if (workspace.hidden) return
        const generation = ++previewGeneration
        previewController?.abort(new DOMException('The preview was superseded.', 'AbortError'))
        const previewAbort = new AbortController()
        previewController = previewAbort
        let recipe: SceneRecipeV2
        try {
            recipe = recipeFromControls()
            state = recipe
            options.onRecipeChange(recipe)
            updateAdmission(recipe)
            syncLookControls(recipe)
        } catch (error) {
            showError(visitorMessage(error, 'Those settings do not work together. Try adjusting them.'), 'preview')
            download.disabled = true
            return
        }
        clearError('preview')
        sizePreviewCanvas()
        try {
            const structure = JSON.stringify({
                // A new device generation (after a loss) needs a new session; the old one's GPU resources are gone.
                generation: options.gpu.current().generation,
                celestialType: recipe.celestialType, seed: recipe.seed, pixels: recipe.pixels,
                palette: recipe.palette, layers: recipe.layers, dither: recipe.dither,
            })
            if (structure !== previewStructure) {
                previewSession?.dispose()
                previewSession = null
                previewBody = null
                previewStructure = structure
            }
            if (!previewSession) {
                if (previewAbort.signal.aborted || generation !== previewGeneration) return
                const session = await createExportSession(recipe, options.gpu, { signal: previewAbort.signal })
                if (previewAbort.signal.aborted || generation !== previewGeneration) {
                    session.dispose()
                    return
                }
                previewSession = session
            }
            Object.assign(previewSession.recipe.body, recipe.body)
            const frame = await previewSession.renderFrame(recipe.body.phase, {
                requestId: 'preview', signal: previewAbort.signal,
            })
            if (previewAbort.signal.aborted || generation !== previewGeneration) return
            acceptFrame(frame, recipe)
            if (fitPending) {
                fitPending = false
                applyFit()
                return
            }
            drawPreview(drag ? state : recipe)
        } catch (error) {
            if (!previewAbort.signal.aborted && generation === previewGeneration) {
                console.error('Export preview failed.', error)
                showError(visitorMessage(error, 'The preview could not be drawn. Try different settings.'), 'preview')
            }
        }
    }

    function acceptFrame(frame: ExportFrame, recipe: SceneRecipeV2): void {
        previewBody = frameCanvas(frame)
        previewArt = { key: artKey(recipe), cells: frame.width, box: alphaBounds(frame.pixels, frame.width, frame.height) }
    }

    /* Light moves re-render the body, so coalesce them: one render in flight, at most one queued, each taking
       the newest light. The old 80 ms debounce restarted on every move, so a steady drag never relit. */
    const runRelight = async (): Promise<void> => {
        relightQueued = false
        if (!relightWanted) return
        relightWanted = false
        const session = previewSession
        const signal = previewController?.signal
        const recipe = state
        // A session built for other settings cannot relight this recipe; the full preview path rebuilds it.
        if (!session || !signal || signal.aborted || workspace.hidden
            || session.recipe.pixels !== recipe.pixels || session.recipe.celestialType !== recipe.celestialType) {
            schedulePreview()
            return
        }
        try {
            Object.assign(session.recipe.body, recipe.body)
            const frame = await session.renderFrame(recipe.body.phase, { requestId: 'preview-light', signal })
            if (signal.aborted || session !== previewSession || workspace.hidden) return
            acceptFrame(frame, recipe)
            drawPreview(state)
        } catch (error) {
            if (!signal.aborted) {
                console.error('Export preview failed.', error)
                showError(visitorMessage(error, 'The preview could not be drawn. Try different settings.'), 'preview')
            }
        }
    }

    const requestRelight = (): void => {
        relightWanted = true
        if (relightQueued) return
        relightQueued = true
        previewWork = previewWork.then(runRelight, runRelight)
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
        state = seedLook(validateSceneRecipe(options.currentRecipe()))
        // A Fit left waiting by the last session must not resize this one's canvas.
        fitPending = false
        changedSinceOpen = false
        statusOutput.textContent = ''
        errorSource = null
        setHidden(errorOutput, true)
        syncControls()
        setHidden(workspace, false)
        setHidden(form, false)
        setHidden($('export-static-controls'), format !== 'png')
        setHidden($('export-animated-controls'), format === 'png')
        setHidden($('export-gif-controls'), format !== 'gif')
        setHidden($('export-spritesheet-controls'), format !== 'spritesheet')
        // Animated frames are always centered, so only the PNG composer offers a planet handle.
        setHidden(bodyHandle, format !== 'png')
        updateBackdropVisibility()
        $('export-title').textContent = format === 'png' ? 'PNG Export Editor' : format === 'gif' ? 'Animated GIF' : 'Spritesheet'
        download.textContent = format === 'png' ? 'Download PNG' : format === 'gif' ? 'Download GIF' : 'Download Spritesheet'
        options.stage.classList.add('export-active')
        panel.classList.add('export-active')
        updateAdmission()
        schedulePreview()
    }

    // Commits a recipe the handles or keyboard produced, without re-rendering unless lighting changed.
    const commitBody = (recipe: SceneRecipeV2, relight: boolean): void => {
        changedSinceOpen = true
        state = recipe
        syncBodyFields(recipe)
        options.onRecipeChange(recipe)
        drawPreview(recipe)
        if (relight) requestRelight()
    }

    form.addEventListener('input', (event) => {
        changedSinceOpen = true
        updateLoopWarning()
        updateBackdropVisibility()
        updateAdmission()
        const target = event.target as HTMLElement
        if (['export-phase', 'export-preview-phase', 'export-pixels', 'export-dither'].includes(target.id) || !previewBody) {
            schedulePreview()
            return
        }
        try {
            state = recipeFromControls()
        } catch {
            return
        }
        options.onRecipeChange(state)
        if (target.id === 'export-width' || target.id === 'export-height') sizePreviewCanvas()
        syncLookControls(state)
        drawPreview(state)
    })
    form.addEventListener('change', (event) => {
        if ((event.target as HTMLElement).id === 'export-pixels') {
            pixelsInput.value = String(options.setPixels(Number(pixelsInput.value)))
            schedulePreview()
        }
        updateAdmission()
    })
    form.addEventListener('submit', (event) => {
        event.preventDefault()
        if (controller) return
        void (async () => {
            const activeController = new AbortController()
            controller = activeController
            download.disabled = true
            setHidden(cancel, false)
            setHidden(progressWrap, false)
            clearError('export')
            statusOutput.textContent = 'Preparing export…'
            try {
                const exportFormat = selectedExportFormat()
                const request = requestFor(exportFormat, recipeFromControls())
                const extension = exportExtension(exportFormat, request.includeMetadata)
                const saveTarget = await acquireExportSaveTarget(
                    exportFilename(request.recipe, exportFormat, request.includeMetadata), exportMediaType(extension))
                if (activeController.signal.aborted) throw activeController.signal.reason
                const runners: Record<ExportFormat, ExportRunner> = {
                    png: exportCompositePng,
                    'scene-package': exportScenePackage,
                    gif: exportGif,
                    spritesheet: exportSpritesheet,
                    'png-sequence': exportPngSequence,
                }
                const runOptions: AnimatedExportRunOptions = {
                    gpu: options.gpu, signal: activeController.signal, onProgress: setProgress,
                    oneBitTransparency: $<HTMLInputElement>('export-gif-transparency').checked,
                    preflightLimits: limits(),
                }
                const output = await runners[exportFormat](request, runOptions)
                for (const file of output.files) await saveExportFile(file, { signal: activeController.signal }, saveTarget)
                statusOutput.textContent = output.warnings.length ? output.warnings.join(' ') : `Saved ${output.files.map((file) => file.filename).join(', ')}.`
            } catch (error) {
                if (error instanceof DOMException && error.name === 'AbortError') statusOutput.textContent = 'Export canceled.'
                else {
                    statusOutput.textContent = ''
                    console.error('Export failed.', error)
                    showError(visitorMessage(error, 'Something went wrong during export. Try again, or try a smaller size.'), 'export')
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
        let closingRecipe = state
        try {
            closingRecipe = recipeFromControls()
        } catch {
            // Invalid fields fall back to the last recipe that validated.
        }
        cancelDrag()
        fitPending = false
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
        state = closingRecipe
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
    // Sizes the canvas to the measured art box, so the planet touches all four edges with no margin.
    function applyFit(): void {
        let recipe: SceneRecipeV2
        try {
            recipe = recipeFromControls()
        } catch {
            return
        }
        const fitted = fitCanvasToArt(canonicalFrameSize(recipe.celestialType, recipe.pixels), recipe.export.scale, artFor(recipe))
        $<HTMLInputElement>('export-width').value = String(fitted.width)
        $<HTMLInputElement>('export-height').value = String(fitted.height)
        $<HTMLInputElement>('export-body-x').value = '0.5'
        $<HTMLInputElement>('export-body-y').value = '0.5'
        $<HTMLSelectElement>('export-size-preset').value = 'custom'
        schedulePreview()
    }
    $('export-fit-canvas').addEventListener('click', () => {
        changedSinceOpen = true
        let recipe: SceneRecipeV2
        try {
            recipe = recipeFromControls()
        } catch {
            return
        }
        // The art box belongs to one pose, so a stale one waits for the next render before fitting.
        if (previewArtFresh(recipe)) applyFit()
        else {
            fitPending = true
            schedulePreview()
        }
    })

    // Plain Pointer Events with capture: handles live in canvas space, so no drag-and-drop layer is needed.
    const recipeAt = (event: PointerEvent): SceneRecipeV2 | null => {
        if (!drag) return null
        const bounds = canvas.getBoundingClientRect()
        const delta: Vec2 = [
            (event.clientX - drag.startClient[0]) * canvas.width / bounds.width,
            (event.clientY - drag.startClient[1]) * canvas.height / bounds.height,
        ]
        const start = drag.startRecipe.body
        if (drag.kind === 'body') {
            // The normalized center tracks the art center, so a preview-pixel delta maps straight onto it.
            const center: [number, number] = [start.center[0] + delta[0] / canvas.width, start.center[1] + delta[1] / canvas.height]
            if (!event.altKey) {
                if (Math.abs(center[0] - 0.5) * canvas.width < SNAP_DISTANCE) center[0] = 0.5
                if (Math.abs(center[1] - 0.5) * canvas.height < SNAP_DISTANCE) center[1] = 0.5
            }
            return { ...drag.startRecipe, body: { ...start, center } }
        }
        if (!start.light) return null
        const { sizeX, sizeY } = drag.startGeometry
        const light = clampBodyLocalLight([start.light[0] + delta[0] / sizeX, start.light[1] + delta[1] / sizeY])
        return { ...drag.startRecipe, body: { ...start, light } }
    }

    const startDrag = (kind: DragKind, event: PointerEvent, target: HTMLElement): void => {
        if (event.button !== 0 || drag || workspace.hidden || (kind === 'body' && format !== 'png')) return
        let recipe: SceneRecipeV2
        try {
            recipe = recipeFromControls()
        } catch {
            return
        }
        if (kind === 'light' && !recipe.body.light) return
        event.preventDefault()
        // preventDefault also cancels the click's focus, and arrow-key nudges listen on the focused target.
        target.focus({ preventScroll: true })
        target.setPointerCapture(event.pointerId)
        drag = {
            kind, pointerId: event.pointerId, target, startClient: [event.clientX, event.clientY],
            startGeometry: previewGeometry(recipe), startRecipe: recipe, moved: false,
        }
    }

    const moveDrag = (event: PointerEvent): void => {
        if (!drag || event.pointerId !== drag.pointerId) return
        const recipe = recipeAt(event)
        if (!recipe) return
        drag.moved = true
        state = recipe
        syncBodyFields(recipe)
        drawPreview(recipe)
        if (drag.kind === 'light') requestRelight()
    }

    const endDrag = (event: PointerEvent): void => {
        if (!drag || event.pointerId !== drag.pointerId) return
        const finished = drag
        // Lost capture carries no trustworthy position, so keep the last moved recipe instead.
        const recipe = event.type === 'lostpointercapture' ? state : recipeAt(event) ?? state
        drag = null
        if (finished.target.hasPointerCapture(event.pointerId)) finished.target.releasePointerCapture(event.pointerId)
        if (finished.moved) commitBody(recipe, finished.kind === 'light')
    }

    function cancelDrag(): void {
        if (!drag) return
        const finished = drag
        drag = null
        if (finished.target.hasPointerCapture(finished.pointerId)) finished.target.releasePointerCapture(finished.pointerId)
        state = finished.startRecipe
        syncBodyFields(state)
        if (!workspace.hidden) drawPreview(state)
    }

    bodyHandle.addEventListener('pointerdown', (event) => { startDrag('body', event, bodyHandle) })
    lightHandle.addEventListener('pointerdown', (event) => { startDrag('light', event, lightHandle) })
    canvas.addEventListener('pointerdown', (event) => {
        let recipe: SceneRecipeV2
        try {
            recipe = recipeFromControls()
        } catch {
            return
        }
        const body = previewGeometry(recipe)
        const bounds = canvas.getBoundingClientRect()
        const point: Vec2 = [(event.clientX - bounds.left) * canvas.width / bounds.width, (event.clientY - bounds.top) * canvas.height / bounds.height]
        if (point[0] >= body.left && point[0] <= body.left + body.sizeX && point[1] >= body.top && point[1] <= body.top + body.sizeY) {
            startDrag('body', event, canvas)
        }
    })
    for (const target of [bodyHandle, lightHandle, canvas] as HTMLElement[]) {
        target.addEventListener('pointermove', moveDrag)
        target.addEventListener('pointerup', endDrag)
        target.addEventListener('pointercancel', cancelDrag)
        target.addEventListener('lostpointercapture', endDrag)
    }

    const nudge = (event: KeyboardEvent, kind: DragKind): void => {
        const deltas: Partial<Record<string, Vec2>> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
        const delta = deltas[event.key]
        if (!delta || drag || (kind === 'body' && format !== 'png')) return
        event.preventDefault()
        let recipe: SceneRecipeV2
        try {
            recipe = recipeFromControls()
        } catch {
            return
        }
        const step = event.shiftKey ? 10 : 1
        if (kind === 'body') {
            const center = nudgeNormalizedCenter(recipe.body.center, recipe.canvas.width, recipe.canvas.height, delta[0] * step, delta[1] * step)
            commitBody({ ...recipe, body: { ...recipe.body, center } }, false)
            return
        }
        if (!recipe.body.light) return
        // One press moves the light one output pixel, which in body-local units is 1/frame size.
        const frame = bodyFrameSize(recipe.celestialType, recipe.pixels, recipe.export.scale)
        const light = clampBodyLocalLight([recipe.body.light[0] + delta[0] * step / frame, recipe.body.light[1] + delta[1] * step / frame])
        commitBody({ ...recipe, body: { ...recipe.body, light } }, true)
    }
    canvas.addEventListener('keydown', (event) => { nudge(event, 'body') })
    bodyHandle.addEventListener('keydown', (event) => { nudge(event, 'body') })
    lightHandle.addEventListener('keydown', (event) => { nudge(event, 'light') })

    const replaceRecipe = (recipe: SceneRecipeV2): void => {
        state = seedLook(validateSceneRecipe(recipe))
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

    return {
        open,
        recipe: () => {
            if (workspace.hidden) return state
            try {
                return recipeFromControls()
            } catch {
                return state
            }
        },
        replaceRecipe,
        refreshFromLive,
    }
}
