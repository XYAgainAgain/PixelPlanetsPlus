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

export type BackdropV1 =
    | { kind: 'transparent' }
    | { kind: 'solid', color: string }
    | {
        kind: 'stars' | 'gradient' | 'stars-gradient'
        seed: number
        density: number
        brightness: number
        starScale: number
        specialStarMix: number
        gradientPhase: number
    }

export interface SceneRecipeV1 {
    schema: 'pixelplanetsplus-scene@1'
    celestialType: PlanetTypeId
    canvas: { width: number, height: number }
    body: {
        center: Vec2
        size: number
        phase: number
        rotation: number
        light: Vec2 | null
    }
    seed: number
    pixels: number
    palette: readonly (readonly string[])[]
    layers: readonly { id: string, visible: boolean }[]
    dither: boolean
    backdrop: BackdropV1
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
    recipe: SceneRecipeV1
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

export interface SpritesheetFrameV1 {
    index: number
    x: number
    y: number
    width: number
    height: number
    phase: number
    durationMilliseconds: number
}

export interface SpritesheetMetadataV1 {
    schema: 'pixelplanetsplus-spritesheet@1'
    celestialType: PlanetTypeId
    image: { width: number, height: number }
    frame: { width: number, height: number, margin: number }
    grid: { columns: number, rows: number, order: 'left-to-right-top-to-bottom' }
    playback: { direction: PlaybackDirection, loop: true, framesPerSecond: number, order: readonly number[] }
    scale: ExportScale
    transparent: boolean
    backdrop: BackdropV1['kind']
    frames: readonly SpritesheetFrameV1[]
}

export interface SequenceMetadataV1 {
    schema: 'pixelplanetsplus-sequence@1'
    celestialType: PlanetTypeId
    frame: { width: number, height: number }
    playback: { direction: PlaybackDirection, loop: true, framesPerSecond: number }
    scale: ExportScale
    transparent: boolean
    backdrop: BackdropV1['kind']
    frames: readonly { index: number, filename: string, phase: number, durationMilliseconds: number }[]
}
