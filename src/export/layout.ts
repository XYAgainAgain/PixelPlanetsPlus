import { PLANETS, type PlanetTypeId, type PlanetValues } from '../tsl/values'
import type { ExportScale, Vec2 } from './types'

export interface SpritesheetRect {
    index: number
    x: number
    y: number
    width: number
    height: number
}

export interface SpritesheetGrid {
    columns: number
    rows: number
    width: number
    height: number
    frames: readonly SpritesheetRect[]
}

export interface ComposerBody {
    center: Vec2
    light: Vec2 | null
}

export interface CanvasBody {
    center: Vec2
    size: number
    light: Vec2 | null
}

export const EXPORT_SCALES: readonly ExportScale[] = [1, 2, 4, 8]

export const bodyLocalToLightUv = (local: readonly [number, number]): [number, number] =>
    [local[0] + 0.5, local[1] + 0.5]

export const lightUvToBodyLocal = (uv: readonly [number, number]): [number, number] =>
    [uv[0] - 0.5, uv[1] - 0.5]

/* The square frame, in art pixels, that holds everything the body draws: the largest layer's quad plus any
   overhang, padded by whole cells (one extra for pixelize's floor) so the art grid stays aligned. */
export const bodyFrameCells = (metadata: PlanetValues, pixels: number): number => {
    const largest = Math.max(...metadata.layers.map((layer) => layer.quadScale))
    const margin = metadata.frameOverhang ? Math.ceil(metadata.frameOverhang * pixels) + 1 : 0
    return Math.max(1, Math.round(pixels * largest) + 2 * margin)
}

// The same frame in base-quad units, which is what the render camera frames.
export const bodyFrameExtent = (metadata: PlanetValues, pixels: number): number =>
    bodyFrameCells(metadata, pixels) / Math.max(1, pixels)

/* The square frame the runtime renders before any zoom: one texel per art pixel, identical to the live view. */
export const canonicalFrameSize = (celestialType: PlanetTypeId, pixels: number): number =>
    bodyFrameCells(PLANETS[celestialType], pixels)

/* How many file pixels the body's frame covers: always an exact integer multiple, so it stays crisp. */
export const bodyFrameSize = (celestialType: PlanetTypeId, pixels: number, scale: ExportScale): number =>
    canonicalFrameSize(celestialType, pixels) * scale

// Picks the whole-number zoom nearest (in doubling steps) to a requested on-canvas frame size.
export function nearestExportScale(desiredFrame: number, canonicalFrame: number): ExportScale {
    assertFinite('desiredFrame', desiredFrame)
    assertPositiveInteger('canonicalFrame', canonicalFrame)
    const target = Math.log2(Math.max(desiredFrame, Number.MIN_VALUE) / canonicalFrame)
    return EXPORT_SCALES.reduce((best, scale) =>
        Math.abs(Math.log2(scale) - target) < Math.abs(Math.log2(best) - target) ? scale : best)
}

export function createSpritesheetGrid(
    frameCount: number,
    columns: number,
    cellWidth: number,
    cellHeight: number,
    margin: number,
): SpritesheetGrid {
    assertPositiveInteger('frameCount', frameCount)
    assertPositiveInteger('columns', columns)
    assertPositiveInteger('cellWidth', cellWidth)
    assertPositiveInteger('cellHeight', cellHeight)
    assertNonNegativeInteger('margin', margin)

    const rows = Math.ceil(frameCount / columns)
    // A margin is a uniform outer gutter and the gap between neighboring cells.
    const width = columns * cellWidth + (columns + 1) * margin
    const height = rows * cellHeight + (rows + 1) * margin
    const frames = Array.from({ length: frameCount }, (_, index): SpritesheetRect => {
        const column = index % columns
        const row = Math.floor(index / columns)
        return {
            index,
            x: margin + column * (cellWidth + margin),
            y: margin + row * (cellHeight + margin),
            width: cellWidth,
            height: cellHeight,
        }
    })

    return { columns, rows, width, height, frames }
}

export function normalizedCenterToCanvasPixels(center: Vec2, canvasWidth: number, canvasHeight: number): Vec2 {
    assertCanvasDimensions(canvasWidth, canvasHeight)
    return [center[0] * canvasWidth, center[1] * canvasHeight]
}

export function canvasPixelsToNormalizedCenter(center: Vec2, canvasWidth: number, canvasHeight: number): Vec2 {
    assertCanvasDimensions(canvasWidth, canvasHeight)
    return [center[0] / canvasWidth, center[1] / canvasHeight]
}

export function bodyLocalLightToCanvasPixels(light: Vec2, center: Vec2, bodySize: number): Vec2 {
    assertFinite('bodySize', bodySize)
    return [center[0] + light[0] * bodySize, center[1] + light[1] * bodySize]
}

export function canvasPixelsToBodyLocalLight(light: Vec2, center: Vec2, bodySize: number): Vec2 {
    assertFinite('bodySize', bodySize)
    if (bodySize === 0) {
        throw new RangeError('bodySize must not be zero')
    }
    return [(light[0] - center[0]) / bodySize, (light[1] - center[1]) / bodySize]
}

// frameSize is the body's frame in the same pixel space as the canvas dimensions.
export function composerBodyToCanvasPixels(body: ComposerBody, frameSize: number, canvasWidth: number, canvasHeight: number): CanvasBody {
    assertFinite('frameSize', frameSize)
    const center = normalizedCenterToCanvasPixels(body.center, canvasWidth, canvasHeight)
    return {
        center,
        size: frameSize,
        light: body.light === null ? null : bodyLocalLightToCanvasPixels(body.light, center, frameSize),
    }
}

export function canvasPixelsToComposerBody(body: CanvasBody, canvasWidth: number, canvasHeight: number): ComposerBody {
    return {
        center: canvasPixelsToNormalizedCenter(body.center, canvasWidth, canvasHeight),
        light: body.light === null ? null : canvasPixelsToBodyLocalLight(body.light, body.center, body.size),
    }
}

export function nudgeNormalizedCenter(center: Vec2, canvasWidth: number, canvasHeight: number, deltaX: number, deltaY: number): Vec2 {
    assertCanvasDimensions(canvasWidth, canvasHeight)
    assertFinite('deltaX', deltaX)
    assertFinite('deltaY', deltaY)
    return [center[0] + deltaX / canvasWidth, center[1] + deltaY / canvasHeight]
}

function assertCanvasDimensions(canvasWidth: number, canvasHeight: number): void {
    assertPositiveInteger('canvasWidth', canvasWidth)
    assertPositiveInteger('canvasHeight', canvasHeight)
}

function assertFinite(name: string, value: number): void {
    if (!Number.isFinite(value)) {
        throw new RangeError(`${name} must be finite`)
    }
}

function assertPositiveInteger(name: string, value: number): void {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`${name} must be a positive integer`)
    }
}

function assertNonNegativeInteger(name: string, value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${name} must be a non-negative integer`)
    }
}
