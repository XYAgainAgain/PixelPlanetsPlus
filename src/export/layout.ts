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

// A rectangle in the body's canonical frame texels.
export interface ArtBox {
    x: number
    y: number
    width: number
    height: number
}

// Where the zoomed canonical frame lands on the canvas, in whole canvas pixels.
export interface BodyPlacement {
    left: number
    top: number
    size: number
    art: ArtBox
}

/* The tight box around every texel with any alpha. Deep-Fold's quantize samples each texel at its corner,
   so a disc fills texels 1…N−1 of its frame: the art sits half a texel right and down of the frame's center. */
export function alphaBounds(pixels: ArrayLike<number>, width: number, height: number): ArtBox | null {
    let minX = width
    let minY = height
    let maxX = -1
    let maxY = -1
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            if (pixels[(y * width + x) * 4 + 3] === 0) continue
            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (y < minY) minY = y
            if (y > maxY) maxY = y
        }
    }
    return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

// Rounds half-integers down, so an odd leftover always puts its spare pixel on the right or bottom margin.
const roundHalfDown = (value: number): number => Math.ceil(value - 0.5 - 1e-9)

/* The normalized center places the visible art's center, not the frame's, so 0.5 splits leftover evenly
   (spare pixel right/bottom) and a canvas sized to the art box fits it with no margin at all. */
export function placeBody(
    center: Vec2,
    canvasWidth: number,
    canvasHeight: number,
    frameCells: number,
    scale: number,
    art: ArtBox | null,
): BodyPlacement {
    assertCanvasDimensions(canvasWidth, canvasHeight)
    assertPositiveInteger('frameCells', frameCells)
    assertPositiveInteger('scale', scale)
    const box = art ?? { x: 0, y: 0, width: frameCells, height: frameCells }
    const artLeft = roundHalfDown(center[0] * canvasWidth - box.width * scale / 2)
    const artTop = roundHalfDown(center[1] * canvasHeight - box.height * scale / 2)
    return { left: artLeft - box.x * scale, top: artTop - box.y * scale, size: frameCells * scale, art: box }
}

// The canvas that holds the art exactly, for "Fit canvas to planet".
export function fitCanvasToArt(frameCells: number, scale: number, art: ArtBox | null): { width: number, height: number } {
    const box = art ?? { x: 0, y: 0, width: frameCells, height: frameCells }
    return { width: box.width * scale, height: box.height * scale }
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
