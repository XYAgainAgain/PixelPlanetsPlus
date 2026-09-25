import { createRng, deriveSeed, type Rng } from '../rng'
import type { BackdropStarsV2, BackdropV2 } from './types'

const STAR_SEED_SALT = 0x53544152
const BASE_STAR_COUNT = 1000
const GRADIENT_RESOLUTION = 128

export interface BackdropSprite {
    width: number
    height: number
    data: Uint8ClampedArray
}

interface StarFrame {
    image: BackdropSprite
    brightImage: BackdropSprite
}

type Canvas = OffscreenCanvas | HTMLCanvasElement
type CanvasContext = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D

const createCanvas = (width: number, height: number): Canvas => {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height)
    if (typeof document !== 'undefined') {
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        return canvas
    }
    throw new Error('Canvas 2D is unavailable.')
}

const contextFor = (canvas: Canvas): CanvasContext => {
    const context = canvas.getContext('2d') as CanvasContext | null
    if (!context) throw new Error('Canvas 2D is unavailable.')
    context.imageSmoothingEnabled = false
    return context
}

const loadBitmap = async (url: URL): Promise<ImageBitmap> => {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Failed to load ${url.pathname}.`)
    return createImageBitmap(await response.blob())
}

const framePixels = (
    source: CanvasImageSource,
    sourceX: number,
    sourceWidth: number,
    sourceHeight: number,
    color: string,
): StarFrame => {
    const width = Math.ceil(sourceWidth)
    const canvas = createCanvas(width, sourceHeight)
    const context = contextFor(canvas)
    context.drawImage(source, sourceX, 0, sourceWidth, sourceHeight, 0, 0, width, sourceHeight)
    context.globalCompositeOperation = 'multiply'
    context.fillStyle = color
    context.fillRect(0, 0, width, sourceHeight)
    context.globalCompositeOperation = 'destination-in'
    context.drawImage(source, sourceX, 0, sourceWidth, sourceHeight, 0, 0, width, sourceHeight)
    context.globalCompositeOperation = 'source-over'
    const image = context.getImageData(0, 0, width, sourceHeight)
    const bright = new Uint8ClampedArray(image.data)
    for (let offset = 0; offset < bright.length; offset += 4) {
        const luminance = bright[offset]! * 0.2126 + bright[offset + 1]! * 0.7152 + bright[offset + 2]! * 0.0722
        if (luminance < 128) bright[offset + 3] = 0
    }
    return {
        image: { width, height: sourceHeight, data: new Uint8ClampedArray(image.data) },
        brightImage: { width, height: sourceHeight, data: bright },
    }
}

const loadFrames = async (): Promise<Map<string, StarFrame>> => {
    const [normal, special] = await Promise.all([
        loadBitmap(new URL('../stars/stars.png', import.meta.url)),
        loadBitmap(new URL('../stars/stars-special.png', import.meta.url)),
    ])
    try {
        const frames = new Map<string, StarFrame>()
        for (const isSpecial of [false, true]) {
            const source = isSpecial ? special : normal
            const frameCount = isSpecial ? 6 : 9
            const sourceWidth = isSpecial ? 25 : 144 / 17
            const sourceHeight = isSpecial ? 25 : normal.height
            for (let frame = 0; frame < frameCount; frame += 1) {
                for (const color of ['#ffef9e', '#ffffff']) {
                    frames.set(`${Number(isSpecial)}:${frame}:${color}`, framePixels(
                        source, frame * (isSpecial ? 25 : 9), sourceWidth, sourceHeight, color,
                    ))
                }
            }
        }
        return frames
    } finally {
        normal.close()
        special.close()
    }
}

let starFrames: Promise<Map<string, StarFrame>> | null = null
const getStarFrames = (): Promise<Map<string, StarFrame>> => {
    if (!starFrames) {
        const pending = loadFrames()
        starFrames = pending
        void pending.catch(() => {
            if (starFrames === pending) starFrames = null
        })
    }
    return starFrames
}

const integer = (rng: Rng, min: number, max: number): number =>
    Math.floor(rng.next() * (max - min + 1) + min)

const parseColor = (color: string): readonly [number, number, number] => {
    const hex = color.startsWith('#') ? color.slice(1) : color
    if (!/^[0-9a-f]{6}$/i.test(hex)) throw new Error(`Unsupported solid backdrop color: ${color}`)
    return [Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16), Number.parseInt(hex.slice(4, 6), 16)]
}

const paintGradient = (output: Uint8ClampedArray, width: number, height: number, phase: number): void => {
    const pixels = new Uint8ClampedArray(GRADIENT_RESOLUTION * GRADIENT_RESOLUTION * 4)
    // One export phase spans the live gradient's full 2π rotation cycle.
    const liveTime = phase * Math.PI * 10
    const rotation = liveTime * 0.2
    const cosRotation = Math.cos(rotation)
    const sinRotation = Math.sin(rotation)
    const blue = Math.abs(Math.cos(liveTime * 0.0253))
    for (let y = 0; y < GRADIENT_RESOLUTION; y += 1) {
        for (let x = 0; x < GRADIENT_RESOLUTION; x += 1) {
            const u = (x + 0.5) / GRADIENT_RESOLUTION
            const v = 1 - (y + 0.5) / GRADIENT_RESOLUTION
            const cx = u - 0.5
            const cy = v - 0.5
            const rx = cx * cosRotation - cy * sinRotation + 0.5
            const ry = cx * sinRotation + cy * cosRotation + 0.5
            const hash = Math.sin(u * 12.9898 + v * 78.233 + liveTime * 0.0000001 * 12.9898) * 43758.5453
            const value = ((hash - Math.floor(hash)) * 0.03 + 1) * 0.168627
            const offset = (y * GRADIENT_RESOLUTION + x) * 4
            pixels[offset] = Math.round(Math.abs(Math.sin(rx + liveTime * 0.105)) * value * 255)
            pixels[offset + 1] = Math.round(Math.abs(Math.sin(Math.cos(rx + ry) + 1 + liveTime * 0.059)) * value * 255)
            pixels[offset + 2] = Math.round(blue * value * 255)
            pixels[offset + 3] = 255
        }
    }
    for (let y = 0; y < height; y += 1) {
        const sourceY = Math.min(GRADIENT_RESOLUTION - 1, Math.floor(y * GRADIENT_RESOLUTION / height))
        for (let x = 0; x < width; x += 1) {
            const sourceX = Math.min(GRADIENT_RESOLUTION - 1, Math.floor(x * GRADIENT_RESOLUTION / width))
            const sourceOffset = (sourceY * GRADIENT_RESOLUTION + sourceX) * 4
            output.set(pixels.subarray(sourceOffset, sourceOffset + 4), (y * width + x) * 4)
        }
    }
}

const blendPixel = (output: Uint8ClampedArray, offset: number, source: BackdropSprite, sourceOffset: number, opacity: number): void => {
    const sourceAlpha = source.data[sourceOffset + 3]! / 255 * opacity
    if (sourceAlpha === 0) return
    const targetAlpha = output[offset + 3]! / 255
    const alpha = sourceAlpha + targetAlpha * (1 - sourceAlpha)
    for (let channel = 0; channel < 3; channel += 1) {
        output[offset + channel] = Math.round((source.data[sourceOffset + channel]! * sourceAlpha
            + output[offset + channel]! * targetAlpha * (1 - sourceAlpha)) / alpha)
    }
    output[offset + 3] = Math.round(alpha * 255)
}

const drawFrame = (
    output: Uint8ClampedArray,
    width: number,
    height: number,
    frame: BackdropSprite,
    left: number,
    top: number,
    size: number,
    opacity: number,
): void => {
    for (let y = Math.max(0, top); y < Math.min(height, top + size); y += 1) {
        const sourceY = Math.min(frame.height - 1, Math.floor((y - top) * frame.height / size))
        for (let x = Math.max(0, left); x < Math.min(width, left + size); x += 1) {
            const sourceX = Math.min(frame.width - 1, Math.floor((x - left) * frame.width / size))
            blendPixel(output, (y * width + x) * 4, frame, (sourceY * frame.width + sourceX) * 4, opacity)
        }
    }
}

const paintStars = (
    output: Uint8ClampedArray,
    width: number,
    height: number,
    backdrop: BackdropStarsV2,
    frames: Map<string, StarFrame>,
): void => {
    const rng = createRng(deriveSeed(backdrop.seed, STAR_SEED_SALT))
    const count = Math.max(0, Math.round(BASE_STAR_COUNT * backdrop.density))
    const focal = Math.max(width, height) / (2 * Math.tan((75 * Math.PI) / 360))
    for (let index = 0; index < count; index += 1) {
        const special = rng.next() > 1 - backdrop.specialStarMix
        const frameIndex = special ? integer(rng, 1, 6) % 6 : integer(rng, 1, 17) % 9
        const color = rng.next() > 0.5 ? '#ffef9e' : '#ffffff'
        const opacity = integer(rng, 0.1, 1)
        const longitude = 2 * Math.PI * rng.next()
        const polar = Math.acos(2 * rng.next() - 1)
        if (opacity === 0) continue
        const x = Math.sin(polar) * Math.cos(longitude)
        const y = Math.sin(polar) * Math.sin(longitude)
        const distance = 1 - Math.cos(polar)
        if (distance < 0.1) continue
        const variant = frames.get(`${Number(special)}:${frameIndex}:${color}`)
        if (!variant) {
            const details = `Missing star frame variant: ${Number(special)}:${frameIndex}:${color}.`
            throw Object.assign(new Error('Something went wrong while rendering the export.'), { cause: new Error(details), details })
        }
        const size = Math.max(1, Math.round(focal * (special ? 0.05 : 0.03) / distance * backdrop.starScale))
        const centerX = width / 2 + focal * x / distance
        const centerY = height / 2 - focal * y / distance
        const image = size < 6 ? variant.brightImage : variant.image
        drawFrame(output, width, height, image, Math.round(centerX - size / 2), Math.round(centerY - size / 2), size,
            Math.max(0, Math.min(1, backdrop.brightness)))
    }
}

export interface BackdropRasterizer {
    renderBand: (startY: number, rowCount: number) => Uint8ClampedArray
}

export const createBackdropRasterizer = async (
    backdrop: BackdropV2,
    width: number,
    height: number,
    loadedFrames?: Map<string, StarFrame>,
): Promise<BackdropRasterizer> => {
    const output = new Uint8ClampedArray(width * height * 4)
    const { base, stars } = backdrop
    if (base.kind === 'solid') {
        const color = parseColor(base.color)
        for (let offset = 0; offset < output.length; offset += 4) {
            output[offset] = color[0]
            output[offset + 1] = color[1]
            output[offset + 2] = color[2]
            output[offset + 3] = 255
        }
    } else if (base.kind === 'gradient') {
        paintGradient(output, width, height, base.phase)
    }
    if (stars) paintStars(output, width, height, stars, loadedFrames ?? await getStarFrames())
    return {
        renderBand: (startY, rowCount) => output.slice(startY * width * 4, (startY + rowCount) * width * 4),
    }
}
