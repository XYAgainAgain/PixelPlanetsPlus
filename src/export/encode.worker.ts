import { GIFEncoder, applyPalette, quantize, type GifEncoderInstance, type GifPalette } from 'gifenc'

type Request =
    | { type: 'gif-start', width: number, height: number, transparent: boolean }
    | { type: 'gif-sample', rgba: Uint8ClampedArray }
    | { type: 'gif-palette' }
    | { type: 'gif-frame', rgba: Uint8ClampedArray, delay: number }
    | { type: 'gif-finish' }

type Response =
    | { type: 'ready' }
    | { type: 'palette-ready' }
    | { type: 'frame-ready' }
    | { type: 'done', bytes: Uint8Array }
    | { type: 'error', message: string }

let width = 0
let height = 0
let transparent = true
const HISTOGRAM_SIZE = 16 * 16 * 16
let histogram = new Uint32Array(HISTOGRAM_SIZE)
let palette: GifPalette | null = null
let transparentIndex = 0
let encoder: GifEncoderInstance | null = null
let frameIndex = 0

const reply = (message: Response, transfer: Transferable[] = []): void => {
    self.postMessage(message, { transfer })
}

const addSample = (rgba: Uint8ClampedArray): void => {
    const pixelCount = rgba.length / 4
    const target = Math.min(pixelCount, 16_384)
    const stride = Math.max(1, Math.floor(pixelCount / target))
    for (let pixel = 0; pixel < pixelCount; pixel += stride) {
        const input = pixel * 4
        if (transparent && rgba[input + 3]! < 128) continue
        const bucket = (rgba[input]! >> 4) << 8 | (rgba[input + 1]! >> 4) << 4 | (rgba[input + 2]! >> 4)
        histogram[bucket] += 1
    }
}

const paletteInput = (): Uint8ClampedArray => {
    const colors: number[] = transparent ? [0, 0, 0, 0] : []
    const total = histogram.reduce((sum, count) => sum + count, 0)
    const divisor = Math.max(1, Math.ceil(total / 16_384))
    for (let bucket = 0; bucket < HISTOGRAM_SIZE; bucket += 1) {
        if (histogram[bucket] === 0) continue
        const repetitions = Math.max(1, Math.floor(histogram[bucket] / divisor))
        for (let repetition = 0; repetition < repetitions; repetition += 1) {
            colors.push(((bucket >> 8) & 15) * 17, ((bucket >> 4) & 15) * 17, (bucket & 15) * 17, 255)
        }
    }
    return new Uint8ClampedArray(colors)
}

self.addEventListener('message', (event: MessageEvent<Request>) => {
    try {
        const request = event.data
        if (request.type === 'gif-start') {
            width = request.width
            height = request.height
            transparent = request.transparent
            histogram = new Uint32Array(HISTOGRAM_SIZE)
            palette = null
            encoder = null
            frameIndex = 0
            reply({ type: 'ready' })
            return
        }
        if (request.type === 'gif-sample') {
            addSample(request.rgba)
            reply({ type: 'ready' })
            return
        }
        if (request.type === 'gif-palette') {
            palette = quantize(paletteInput(), 256, {
                format: transparent ? 'rgba4444' : 'rgb565',
                oneBitAlpha: transparent,
            })
            transparentIndex = transparent ? palette.findIndex((color) => (color[3] ?? 255) === 0) : 0
            if (transparent && transparentIndex < 0) {
                throw new Error('GIF palette quantization did not preserve a transparent color entry.')
            }
            histogram = new Uint32Array(HISTOGRAM_SIZE)
            encoder = GIFEncoder()
            reply({ type: 'palette-ready' })
            return
        }
        if (request.type === 'gif-frame') {
            if (!palette || !encoder) throw new Error('GIF palette is not ready')
            const indexed = applyPalette(request.rgba, palette, transparent ? 'rgba4444' : 'rgb565')
            encoder.writeFrame(indexed, width, height, {
                palette: frameIndex === 0 ? palette : undefined,
                transparent,
                transparentIndex,
                delay: request.delay * 10,
                dispose: transparent ? 2 : undefined,
                repeat: 0,
            } as Parameters<GifEncoderInstance['writeFrame']>[3] & { dispose?: number })
            frameIndex += 1
            reply({ type: 'frame-ready' })
            return
        }
        if (!encoder) throw new Error('GIF encoder is not ready')
        encoder.finish()
        const bytes = encoder.bytes()
        reply({ type: 'done', bytes }, [bytes.buffer])
        encoder = null
    } catch (error: unknown) {
        reply({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
})
