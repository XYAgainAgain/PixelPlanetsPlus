import type { PlanetTypeId } from '../tsl/values'

export type Vec2 = readonly [number, number]
export type ExportScale = 1 | 2 | 4 | 8
export type PlaybackDirection = 'forward' | 'reverse' | 'ping-pong'

export interface ExportEffectV1 {
    id: string
    version: number
    enabled: boolean
    parameters: Readonly<Record<string, boolean | number | string>>
}

export type BackdropBaseV2 =
    | { kind: 'transparent' }
    | { kind: 'solid', color: string }
    | { kind: 'gradient', phase: number }

export interface BackdropStarsV2 {
    seed: number
    density: number
    brightness: number
    starScale: number
    specialStarMix: number
}

// An opaque or transparent base with an optional star layer over it, so every pairing exists.
export interface BackdropV2 {
    base: BackdropBaseV2
    stars: BackdropStarsV2 | null
}

// Planet-first sizing: the body renders at its canonical frame (layout.ts) and is enlarged by the whole-number
// export.scale, so its size in the file is never a free parameter that could contradict those two.
export interface SceneRecipeV2 {
    schema: 'pixelplanetsplus-scene@2'
    celestialType: PlanetTypeId
    canvas: { width: number, height: number }
    body: {
        center: Vec2
        phase: number
        rotation: number
        light: Vec2 | null
    }
    seed: number
    pixels: number
    palette: readonly (readonly string[])[]
    layers: readonly { id: string, visible: boolean }[]
    dither: boolean
    backdrop: BackdropV2
    export: {
        scale: ExportScale
        frameCount: number
        columns: number
        margin: number
        startPhase: number
        endPhase: number
        direction: PlaybackDirection
        framesPerSecond: number
    }
    effects: readonly ExportEffectV1[]
}

export type ExportFormat = 'png' | 'gif' | 'spritesheet' | 'png-sequence' | 'scene-package'

export interface RenderRequest {
    id: string
    recipe: SceneRecipeV2
    format: ExportFormat
    includeMetadata: boolean
    includeLayers: boolean
}

export type RenderStage = 'preflight' | 'render' | 'palette' | 'encode' | 'package'

export interface RenderProgress {
    requestId: string
    stage: RenderStage
    completed: number
    total: number
}

export interface RenderArtifact {
    filename: string
    mediaType: string
    byteLength: number
}

export interface RenderResult {
    requestId: string
    artifacts: readonly RenderArtifact[]
    warnings: readonly string[]
}

export interface BackdropSummaryV2 {
    base: BackdropBaseV2['kind']
    stars: boolean
}

// Cell i shows phase first + i × step; frames are always evenly sampled.
export interface PhaseRangeV2 {
    first: number
    step: number
}

export interface SpritesheetMetadataV2 {
    schema: 'pixelplanetsplus-spritesheet@2'
    celestialType: PlanetTypeId
    image: { width: number, height: number }
    frame: { width: number, height: number }
    // Cell i sits at x = margin + (i % columns) × (frame.width + margin), y = margin + ⌊i / columns⌋ × (frame.height + margin).
    grid: { count: number, columns: number, rows: number, margin: number }
    phases: PhaseRangeV2
    // order lists cell indices in playback order; it is omitted when cells already play in order.
    playback: { direction: PlaybackDirection, loop: true, framesPerSecond: number, frameDurationMilliseconds: number, order?: readonly number[] }
    scale: ExportScale
    transparent: boolean
    backdrop: BackdropSummaryV2
}

export interface SequenceMetadataV2 {
    schema: 'pixelplanetsplus-sequence@2'
    celestialType: PlanetTypeId
    frame: { width: number, height: number }
    // File i (0-based) is prefix + String(i + 1).padStart(digits, '0') + '.png'.
    files: { count: number, prefix: string, digits: number }
    // Ping-Pong revisits phases, so it lists every file's phase instead of a range.
    phases: PhaseRangeV2 | readonly number[]
    playback: { direction: PlaybackDirection, loop: true, framesPerSecond: number, frameDurationMilliseconds: number }
    scale: ExportScale
    transparent: boolean
    backdrop: BackdropSummaryV2
}
