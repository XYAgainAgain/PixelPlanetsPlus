import { TEXTURE_CEILING } from '../gpu'
import { PLANETS } from '../tsl/values'
import { SCENE_PACKAGE_BASE_PASSES } from './contract'
import { canonicalFrameSize } from './layout'
import type { RenderRequest } from './types'

export interface PreflightLimits {
    // The device's own limit; preflight caps it at TEXTURE_CEILING itself.
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
    const canonical = canonicalFrameSize(request.recipe.celestialType, request.recipe.pixels)
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
    // Counting every layer, hidden ones too, keeps the estimate at or above what the exporter can retain.
    const layerPasses = request.includeLayers ? PLANETS[request.recipe.celestialType].layers.length : 0
    const packageImages = format === 'scene-package' ? SCENE_PACKAGE_BASE_PASSES.length + layerPasses : 1
    const passBufferBytes = format === 'scene-package' ? outputBytes * packageImages : 0
    const renderTargetBytes = canonical * canonical * 4
    const gpuTextureBytes = renderTargetBytes * 2
    // Animated frames hold, at once: the frozen backdrop, the readback plus its straightened copy and 2D
    // source canvas, and the zoomed output canvas; GIF adds the transferred RGBA and its indexed frame.
    const { backdrop } = request.recipe
    const frozenBackdropBytes = backdrop.base.kind !== 'transparent' || backdrop.stars ? frameBytes : 0
    const frameWorkBytes = frozenBackdropBytes + renderTargetBytes * 3 + frameBytes
    const encoderBytes = format === 'gif'
        ? frameWorkBytes + frameBytes + frameWidth * frameHeight + 4096 * 4 + 256 * 4 + 32_768 * 4
        : format === 'spritesheet'
            ? frameWorkBytes + outputBytes
            : format === 'png-sequence'
                ? frameWorkBytes + frameBytes
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
    const textureLimit = Math.min(limits.maxTextureDimension2D, TEXTURE_CEILING)
    const deviceReason = 'That size is too big for this device. Try a smaller canvas or a lower scale.'
    const memoryReason = 'That export needs more memory than this device has. Try a smaller canvas, fewer frames, or a lower scale.'
    const reject = (reason: string, detail: string): void => {
        if (!reasons.includes(reason)) reasons.push(reason)
        details.push(detail)
    }

    if (!Number.isInteger(textureLimit) || textureLimit < 1) {
        reject(deviceReason, `Device texture/render-target limit must be a positive integer; received ${textureLimit}.`)
    } else {
        // One ceiling for every edge, so the answer never depends on which backend or output format is in play.
        const edges: readonly [string, number][] = [
            ['Canonical render-target width', estimate.renderTarget.width],
            ['Canonical render-target height', estimate.renderTarget.height],
            ['Output width', estimate.output.width],
            ['Output height', estimate.output.height],
        ]
        for (const [label, value] of edges) {
            if (value > textureLimit) reject(deviceReason, `${label} ${value}px exceeds the export ceiling of ${textureLimit}px.`)
        }
    }

    if (limits.maxWorkingBytes !== undefined && estimate.peakWorkingBytes > limits.maxWorkingBytes) {
        reject(memoryReason, `Worst-case working memory ${bytes(estimate.peakWorkingBytes)} exceeds the configured limit of ${bytes(limits.maxWorkingBytes)}.`)
    }
    if (limits.maxBlobBytes !== undefined && estimate.blobBytes > limits.maxBlobBytes) {
        reject(memoryReason, `Worst-case Blob memory ${bytes(estimate.blobBytes)} exceeds the configured limit of ${bytes(limits.maxBlobBytes)}.`)
    }

    return { admitted: reasons.length === 0, reasons, details, estimate }
}
