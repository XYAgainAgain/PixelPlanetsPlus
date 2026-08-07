import { PLANET_FACTORIES } from '../tsl/registry'
import { PLANETS } from '../tsl/values'
import { MAX_EXPORT_DIMENSION, MAX_EXPORT_PIXELS } from './recipe'
import type { RenderRequest } from './types'

export interface PreflightLimits {
    maxTextureDimension2D: number
    maxWorkingBytes?: number
    maxBlobBytes?: number
}

export interface PreflightEstimate {
    renderTarget: { width: number, height: number }
    frame: { width: number, height: number }
    output: { width: number, height: number, pixels: number }
    gpuTextureBytes: number
    encoderBytes: number
    passBufferBytes: number
    compressedOutputBytes: number
    blobBytes: number
    peakWorkingBytes: number
}

export interface PreflightResult {
    admitted: boolean
    reasons: readonly string[]
    details: readonly string[]
    estimate: PreflightEstimate
}

const bytes = (value: number): string => {
    const mib = value / (1024 * 1024)
    return mib >= 1024 ? `${(mib / 1024).toFixed(2)} GiB` : `${mib.toFixed(2)} MiB`
}

const dimensions = (request: RenderRequest): PreflightEstimate => {
    const planetName = PLANETS[request.recipe.celestialType].name
    const factory = PLANET_FACTORIES.find((entry) => entry.metadata.name === planetName)
    if (!factory) throw new Error(`unknown celestial body: ${request.recipe.celestialType}`)
    const canonical = Math.round(request.recipe.pixels * factory.metadata.relativeScale)
    const scale = request.recipe.export.scale
    const frameWidth = canonical * scale
    const frameHeight = frameWidth
    const { format } = request
    let outputWidth = frameWidth
    let outputHeight = frameHeight

    if (format === 'png' || format === 'scene-package') {
        outputWidth = request.recipe.canvas.width
        outputHeight = request.recipe.canvas.height
    } else if (format === 'spritesheet') {
        const columns = request.recipe.export.columns
        const rows = Math.ceil(request.recipe.export.frameCount / columns)
        const margin = request.recipe.export.margin
        outputWidth = columns * frameWidth + (columns + 1) * margin
        outputHeight = rows * frameHeight + (rows + 1) * margin
    }

    const outputPixels = outputWidth * outputHeight
    const frameBytes = frameWidth * frameHeight * 4
    const outputBytes = outputPixels * 4
    const layerPasses = request.includeLayers ? factory.metadata.layers.length : 0
    const packageImages = format === 'scene-package' ? 3 + layerPasses : 1
    const passBufferBytes = format === 'scene-package' ? outputBytes * packageImages : 0
    const renderTargetBytes = canonical * canonical * 4
    const gpuTextureBytes = renderTargetBytes * 2
    const encoderBytes = format === 'gif'
        ? frameBytes + frameWidth * frameHeight + 256 * 4 + 32_768 * 4
        : outputBytes
    const uncompressedOutputBytes = format === 'gif'
        ? frameWidth * frameHeight * request.recipe.export.frameCount
        : format === 'png-sequence'
            ? frameBytes * request.recipe.export.frameCount
            : outputBytes * packageImages
    const compressedOutputBytes = Math.ceil(uncompressedOutputBytes * 1.01) + 65_536
    const blobBytes = compressedOutputBytes
    const peakWorkingBytes = gpuTextureBytes + encoderBytes + passBufferBytes + compressedOutputBytes + blobBytes

    return {
        renderTarget: { width: canonical, height: canonical },
        frame: { width: frameWidth, height: frameHeight },
        output: { width: outputWidth, height: outputHeight, pixels: outputPixels },
        gpuTextureBytes,
        encoderBytes,
        passBufferBytes,
        compressedOutputBytes,
        blobBytes,
        peakWorkingBytes,
    }
}

export const preflightRenderRequest = (request: RenderRequest, limits: PreflightLimits): PreflightResult => {
    const estimate = dimensions(request)
    const reasons: string[] = []
    const details: string[] = []
    const textureLimit = limits.maxTextureDimension2D
    const deviceReason = 'That size is too big for this device. Try a smaller canvas or a lower scale.'
    const memoryReason = 'That export needs more memory than this device has. Try a smaller canvas, fewer frames, or a lower scale.'
    const reject = (reason: string, detail: string): void => {
        if (!reasons.includes(reason)) reasons.push(reason)
        details.push(detail)
    }

    if (!Number.isInteger(textureLimit) || textureLimit < 1) {
        reject(deviceReason, `Device texture/render-target limit must be a positive integer; received ${textureLimit}.`)
    } else {
        if (estimate.renderTarget.width > textureLimit) {
            reject(deviceReason, `Canonical render-target width ${estimate.renderTarget.width}px exceeds the device texture/render-target limit of ${textureLimit}px.`)
        }
        if (estimate.renderTarget.height > textureLimit) {
            reject(deviceReason, `Canonical render-target height ${estimate.renderTarget.height}px exceeds the device texture/render-target limit of ${textureLimit}px.`)
        }
        if (request.format === 'spritesheet' && estimate.output.width > textureLimit) {
            reject(deviceReason, `Spritesheet width ${estimate.output.width}px exceeds the device texture/render-target limit of ${textureLimit}px.`)
        }
        if (request.format === 'spritesheet' && estimate.output.height > textureLimit) {
            reject(deviceReason, `Spritesheet height ${estimate.output.height}px exceeds the device texture/render-target limit of ${textureLimit}px.`)
        }
    }

    if (estimate.output.width > MAX_EXPORT_DIMENSION) {
        reject(deviceReason, `Output width ${estimate.output.width}px exceeds the format ceiling of ${MAX_EXPORT_DIMENSION}px.`)
    }
    if (estimate.output.height > MAX_EXPORT_DIMENSION) {
        reject(deviceReason, `Output height ${estimate.output.height}px exceeds the format ceiling of ${MAX_EXPORT_DIMENSION}px.`)
    }
    if (estimate.output.pixels > MAX_EXPORT_PIXELS) {
        reject(deviceReason, `Output area ${estimate.output.pixels.toLocaleString('en-US')} pixels exceeds the format ceiling of ${MAX_EXPORT_PIXELS.toLocaleString('en-US')} pixels.`)
    }
    if (limits.maxWorkingBytes !== undefined && estimate.peakWorkingBytes > limits.maxWorkingBytes) {
        reject(memoryReason, `Worst-case working memory ${bytes(estimate.peakWorkingBytes)} exceeds the configured limit of ${bytes(limits.maxWorkingBytes)}.`)
    }
    if (limits.maxBlobBytes !== undefined && estimate.blobBytes > limits.maxBlobBytes) {
        reject(memoryReason, `Worst-case Blob memory ${bytes(estimate.blobBytes)} exceeds the configured limit of ${bytes(limits.maxBlobBytes)}.`)
    }

    return { admitted: reasons.length === 0, reasons, details, estimate }
}
