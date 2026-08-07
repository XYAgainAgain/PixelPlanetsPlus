import type { PlaybackDirection } from './types'

const FULL_CYCLE = 1
const FULL_CYCLE_TOLERANCE = 1e-9

export function generatePhaseSamples(
    startPhase: number,
    endPhase: number,
    frameCount: number,
    direction: PlaybackDirection,
): number[] {
    assertFinite('startPhase', startPhase)
    assertFinite('endPhase', endPhase)
    assertPositiveInteger('frameCount', frameCount)

    if (frameCount === 1) {
        return [direction === 'reverse' ? endPhase : startPhase]
    }

    if (direction === 'ping-pong') {
        return generatePingPongSamples(startPhase, endPhase, frameCount)
    }

    const isFullCycle = Math.abs(Math.abs(endPhase - startPhase) - FULL_CYCLE)
        <= FULL_CYCLE_TOLERANCE * Math.max(1, Math.abs(startPhase), Math.abs(endPhase))
    const steps = isFullCycle ? frameCount : frameCount - 1
    const from = direction === 'forward' ? startPhase : endPhase
    const to = direction === 'forward' ? endPhase : startPhase

    return Array.from({ length: frameCount }, (_, index) => from + (to - from) * index / steps)
}

export function loopsSeamlessly(
    startPhase: number,
    endPhase: number,
    direction: PlaybackDirection,
): boolean {
    assertFinite('startPhase', startPhase)
    assertFinite('endPhase', endPhase)

    return direction === 'ping-pong' || Math.abs(Math.abs(endPhase - startPhase) - FULL_CYCLE)
        <= FULL_CYCLE_TOLERANCE * Math.max(1, Math.abs(startPhase), Math.abs(endPhase))
}

export function distributeGifDelays(
    framesPerSecond: number,
    frameCount: number,
): number[] {
    assertFinite('framesPerSecond', framesPerSecond)
    assertPositiveInteger('frameCount', frameCount)
    if (framesPerSecond <= 0) {
        throw new RangeError('framesPerSecond must be greater than zero')
    }

    const totalCentiseconds = Math.round(frameCount * 100 / framesPerSecond)
    return Array.from(
        { length: frameCount },
        (_, index) => Math.round((index + 1) * totalCentiseconds / frameCount)
            - Math.round(index * totalCentiseconds / frameCount),
    )
}

function generatePingPongSamples(startPhase: number, endPhase: number, frameCount: number): number[] {
    if (frameCount < 4 || frameCount % 2 !== 0) {
        throw new RangeError('Ping-Pong requires an even frame count of at least 4.')
    }
    const outboundCount = frameCount / 2 + 1
    const outbound = Array.from(
        { length: outboundCount },
        (_, index) => startPhase + (endPhase - startPhase) * index / (outboundCount - 1),
    )
    return [...outbound, ...outbound.slice(1, -1).reverse()]
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
