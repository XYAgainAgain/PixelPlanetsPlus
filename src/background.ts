import { createRng, deriveSeed, type Rng } from './rng'

export const BACKGROUND_MODES = ['None', 'Stars', 'Gradient', 'Stars on Gradient'] as const
export type BackgroundMode = typeof BACKGROUND_MODES[number]

const STAR_COUNT = 1000
const STAR_SEED_SALT = 0x53544152
const GRADIENT_RESOLUTION = 128
const GRADIENT_INTERVAL = 1 / 12
const TURN = Math.PI * 2

const loadImage = (url: URL): Promise<HTMLImageElement> => new Promise((resolve, reject) => {
    const image = new Image()
    image.addEventListener('load', () => { resolve(image) }, { once: true })
    image.addEventListener('error', () => { reject(new Error(`failed to load ${url.pathname}`)) }, { once: true })
    image.src = url.href
})

const starImages = Promise.all([
    loadImage(new URL('./stars/stars.png', import.meta.url)),
    loadImage(new URL('./stars/stars-special.png', import.meta.url)),
])

const integer = (rng: Rng, min: number, max: number): number =>
    Math.floor(rng.next() * (max - min + 1) + min)

interface StarFrame {
    image: HTMLCanvasElement
}

const createFrames = (normal: HTMLImageElement, special: HTMLImageElement): Map<string, StarFrame> => {
    const frames = new Map<string, StarFrame>()
    for (const isSpecial of [false, true]) {
        const source = isSpecial ? special : normal
        const frameCount = isSpecial ? 6 : 9
        const sourceWidth = isSpecial ? 25 : 144 / 17
        const sourceHeight = isSpecial ? 25 : normal.height
        for (let frame = 0; frame < frameCount; frame += 1) {
            for (const color of ['#ffef9e', '#ffffff']) {
                const canvas = document.createElement('canvas')
                canvas.width = Math.ceil(sourceWidth)
                canvas.height = sourceHeight
                const context = canvas.getContext('2d')
                if (!context) throw new Error('Canvas 2D is unavailable')
                context.imageSmoothingEnabled = false
                context.drawImage(source, frame * (isSpecial ? 25 : 9), 0, sourceWidth, sourceHeight,
                    0, 0, canvas.width, canvas.height)
                context.globalCompositeOperation = 'multiply'
                context.fillStyle = color
                context.fillRect(0, 0, canvas.width, canvas.height)
                context.globalCompositeOperation = 'destination-in'
                context.drawImage(source, frame * (isSpecial ? 25 : 9), 0, sourceWidth, sourceHeight,
                    0, 0, canvas.width, canvas.height)
                frames.set(`${Number(isSpecial)}:${frame}:${color}`, { image: canvas })
            }
        }
    }
    return frames
}

export interface BackgroundRuntime {
    mode: BackgroundMode
    reseed: (seed: number) => void
    resize: (width: number, height: number, pixels: number) => void
    update: (time: number, delta: number) => void
    dispose: () => void
}

export const createBackground = (
    mode: BackgroundMode,
    seed: number,
    backdropCanvas: HTMLCanvasElement,
): BackgroundRuntime => {
    const hasStars = mode === 'Stars' || mode === 'Stars on Gradient'
    const hasGradient = mode === 'Gradient' || mode === 'Stars on Gradient'
    const gradientCanvas = document.createElement('canvas')
    gradientCanvas.width = GRADIENT_RESOLUTION
    gradientCanvas.height = GRADIENT_RESOLUTION
    const gradientContext = gradientCanvas.getContext('2d')
    const backdropContext = backdropCanvas.getContext('2d')
    const starRaster = document.createElement('canvas')
    const starContext = starRaster.getContext('2d')
    if (!gradientContext || !backdropContext || !starContext) throw new Error('Canvas 2D is unavailable')

    let starSeed = seed
    let starResolution = 256
    let disposed = false
    let frames: Map<string, StarFrame> | null = null
    let lastGradientTime = Number.NEGATIVE_INFINITY

    backdropCanvas.hidden = mode === 'None'
    if (mode === 'None') backdropContext.clearRect(0, 0, backdropCanvas.width, backdropCanvas.height)

    const drawGradient = (time: number): void => {
        const image = gradientContext.createImageData(GRADIENT_RESOLUTION, GRADIENT_RESOLUTION)
        const rotationPhase = (time * 0.2) % TURN
        const redPhase = (time * 0.105) % TURN
        const greenPhase = (time * 0.059) % TURN
        const bluePhase = (time * 0.0253) % TURN
        const noisePhase = (time * 0.0000001 * 12.9898) % TURN
        const cosRotation = Math.cos(rotationPhase)
        const sinRotation = Math.sin(rotationPhase)
        const blue = Math.abs(Math.cos(bluePhase))

        for (let y = 0; y < GRADIENT_RESOLUTION; y += 1) {
            for (let x = 0; x < GRADIENT_RESOLUTION; x += 1) {
                const u = (x + 0.5) / GRADIENT_RESOLUTION
                const v = 1 - (y + 0.5) / GRADIENT_RESOLUTION
                const centeredX = u - 0.5
                const centeredY = v - 0.5
                const rotatedX = centeredX * cosRotation - centeredY * sinRotation + 0.5
                const rotatedY = centeredX * sinRotation + centeredY * cosRotation + 0.5
                const hash = Math.sin(u * 12.9898 + v * 78.233 + noisePhase) * 43758.5453
                const noise = hash - Math.floor(hash)
                const brightness = (noise * 0.03 + 1) * 0.168627
                const offset = (y * GRADIENT_RESOLUTION + x) * 4
                image.data[offset] = Math.round(Math.abs(Math.sin(rotatedX + redPhase)) * brightness * 255)
                image.data[offset + 1] = Math.round(Math.abs(Math.sin(Math.cos(rotatedX + rotatedY) + 1 + greenPhase)) * brightness * 255)
                image.data[offset + 2] = Math.round(blue * brightness * 255)
                image.data[offset + 3] = 255
            }
        }
        gradientContext.putImageData(image, 0, 0)
    }

    const compose = (time: number): void => {
        if (disposed) return
        backdropContext.clearRect(0, 0, starResolution, starResolution)
        backdropContext.imageSmoothingEnabled = false
        if (hasGradient) {
            drawGradient(time)
            backdropContext.drawImage(gradientCanvas, 0, 0, starResolution, starResolution)
        }
        if (hasStars && frames) backdropContext.drawImage(starRaster, 0, 0)
    }

    const rasterizeStars = (): void => {
        if (!hasStars || disposed || !frames) return
        starRaster.width = starResolution
        starRaster.height = starResolution
        starContext.clearRect(0, 0, starResolution, starResolution)
        starContext.imageSmoothingEnabled = false
        const rng = createRng(deriveSeed(starSeed, STAR_SEED_SALT))
        const focal = starResolution / (2 * Math.tan((75 * Math.PI) / 360))

        for (let i = 0; i < STAR_COUNT; i += 1) {
            const special = rng.next() > 0.5
            const frame = special ? integer(rng, 1, 6) % 6 : integer(rng, 1, 17) % 9
            const color = rng.next() > 0.5 ? '#ffef9e' : '#ffffff'
            const opacity = integer(rng, 0.1, 1)
            const longitude = 2 * Math.PI * rng.next()
            const polar = Math.acos(2 * rng.next() - 1)
            if (opacity === 0) continue
            const x = Math.sin(polar) * Math.cos(longitude)
            const y = Math.sin(polar) * Math.sin(longitude)
            const z = Math.cos(polar)
            const distance = 1 - z
            if (distance < 0.1) continue
            const variant = frames.get(`${Number(special)}:${frame}:${color}`)
            if (!variant) throw new Error('missing star frame variant')
            const size = Math.max(1, Math.round(focal * (special ? 0.05 : 0.03) / distance))
            const centerX = starResolution / 2 + focal * x / distance
            const centerY = starResolution / 2 - focal * y / distance
            starContext.drawImage(variant.image, Math.round(centerX - size / 2), Math.round(centerY - size / 2), size, size)
        }
        compose(Math.max(0, lastGradientTime))
    }

    if (hasStars) {
        void starImages.then(([normal, special]) => {
            if (disposed) return
            frames = createFrames(normal, special)
            rasterizeStars()
        }).catch((error: unknown) => { console.error('Star textures failed to load.', error) })
    }

    return {
        mode,
        reseed: (nextSeed) => {
            starSeed = nextSeed
            rasterizeStars()
        },
        resize: (width, height, pixels) => {
            const displaySize = Math.max(width, height)
            backdropCanvas.style.inlineSize = `${displaySize}px`
            backdropCanvas.style.blockSize = `${displaySize}px`
            const nextResolution = Math.max(128, Math.min(1024, Math.round(pixels)))
            if (nextResolution !== starResolution || backdropCanvas.width !== nextResolution) {
                starResolution = nextResolution
                backdropCanvas.width = starResolution
                backdropCanvas.height = starResolution
                rasterizeStars()
                compose(Math.max(0, lastGradientTime))
            }
        },
        update: (time) => {
            if (!hasGradient || time - lastGradientTime < GRADIENT_INTERVAL) return
            lastGradientTime = time
            compose(time)
        },
        dispose: () => {
            disposed = true
        },
    }
}
