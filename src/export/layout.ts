import type { Vec2 } from './types'

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
    size: number
    light: Vec2 | null
}

export interface CanvasBody {
    center: Vec2
    size: number
    light: Vec2 | null
}

export interface SnappedBodySize {
    scale: number
    size: number
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

export function normalizedSizeToCanvasPixels(size: number, canvasWidth: number, canvasHeight: number): number {
    assertFinite('size', size)
    assertCanvasDimensions(canvasWidth, canvasHeight)
    return size * Math.min(canvasWidth, canvasHeight)
}

export function canvasPixelsToNormalizedSize(size: number, canvasWidth: number, canvasHeight: number): number {
    assertFinite('size', size)
    assertCanvasDimensions(canvasWidth, canvasHeight)
    return size / Math.min(canvasWidth, canvasHeight)
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

export function composerBodyToCanvasPixels(body: ComposerBody, canvasWidth: number, canvasHeight: number): CanvasBody {
    const center = normalizedCenterToCanvasPixels(body.center, canvasWidth, canvasHeight)
    const size = normalizedSizeToCanvasPixels(body.size, canvasWidth, canvasHeight)
    return {
        center,
        size,
        light: body.light === null ? null : bodyLocalLightToCanvasPixels(body.light, center, size),
    }
}

export function canvasPixelsToComposerBody(body: CanvasBody, canvasWidth: number, canvasHeight: number): ComposerBody {
    return {
        center: canvasPixelsToNormalizedCenter(body.center, canvasWidth, canvasHeight),
        size: canvasPixelsToNormalizedSize(body.size, canvasWidth, canvasHeight),
        light: body.light === null ? null : canvasPixelsToBodyLocalLight(body.light, body.center, body.size),
    }
}

export function snapBodySizeToIntegerScale(desiredSize: number, logicalResolution: number): SnappedBodySize {
    assertFinite('desiredSize', desiredSize)
    assertPositiveInteger('logicalResolution', logicalResolution)

    const scale = Math.max(1, Math.round(desiredSize / logicalResolution))
    return { scale, size: scale * logicalResolution }
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
