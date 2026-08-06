import { Color, generateColorscheme } from './palette'
import { createRng } from './rng'

export interface PaletteTarget {
    read: () => Color
    write: (color: Color) => void
}

export interface PaletteController {
    colors: () => Color[]
    setColors: (colors: readonly Color[]) => void
    randomize: () => void
    reset: () => void
    setSeed: (seed: number) => void
}

type TargetGroups = readonly (readonly PaletteTarget[])[]

const range = (rng: () => number, low: number, high: number): number => low + rng() * (high - low)
const count = (rng: () => number, base: number, span: number): number => base + Math.floor(rng() * span)

const shifted = (color: Color, hue: number): Color => {
    color.h += hue
    return color
}

const terranFamily = (seedColors: Color[], landCount: number): Color[] => {
    const land = Array.from({ length: landCount }, (_, i) =>
        shifted(seedColors[0]!.darkened(i / landCount), 0.2 * (i / 4)))
    const secondary = Array.from({ length: 3 }, (_, i) =>
        shifted(seedColors[1]!.darkened(i / 3), 0.2 * (i / 3)))
    const clouds = Array.from({ length: 4 }, (_, i) =>
        shifted(seedColors[2]!.lightened((1 - i / 4) * 0.8), 0.2 * (i / 4)))
    return [...land, ...secondary, ...clouds]
}

const groundColors = (seedColors: Color[]): Color[] => Array.from({ length: 3 }, (_, i) =>
    seedColors[i]!.darkened(i / 3).lightened((1 - i / 3) * 0.2))

const ramp = (seedColors: Color[], divisor: number, lighten: number, darkenScale = 1): Color[] =>
    seedColors.map((color, i) => color.darkened((i / divisor) * darkenScale)
        .lightened((1 - i / seedColors.length) * lighten))

const generateForType = (type: string, rng: () => number): Color[] => {
    switch (type) {
        case 'Terran Wet': {
            const generated = generateColorscheme(count(rng, 3, 2), range(rng, 0.7, 1), range(rng, 0.45, 0.55), rng)
            const land = Array.from({ length: 4 }, (_, i) => shifted(generated[0]!.darkened(i / 4), 0.2 * (i / 4)))
            const rivers = Array.from({ length: 2 }, (_, i) => shifted(generated[1]!.darkened(i / 2), 0.2 * (i / 2)))
            const clouds = Array.from({ length: 4 }, (_, i) => shifted(generated[2]!.lightened((1 - i / 4) * 0.8), 0.2 * (i / 4)))
            return [...land, ...rivers, ...clouds]
        }
        case 'Terran Dry': {
            const generated = generateColorscheme(count(rng, 5, 3), range(rng, 0.3, 0.65), 1, rng)
            return generated.slice(0, 5).map((color, i) => color.darkened(i / 5).lightened((1 - i / 5) * 0.2))
        }
        case 'Islands': {
            const generated = generateColorscheme(count(rng, 3, 2), range(rng, 0.7, 1), range(rng, 0.45, 0.55), rng)
            const land = Array.from({ length: 4 }, (_, i) => shifted(generated[0]!.darkened(i / 4), 0.2 * (i / 4)))
            const water = Array.from({ length: 3 }, (_, i) => shifted(generated[1]!.darkened(i / 5), 0.1 * (i / 2)))
            const clouds = Array.from({ length: 4 }, (_, i) => shifted(generated[2]!.lightened((1 - i / 4) * 0.8), 0.2 * (i / 4)))
            const atmosphere = Array.from({ length: 3 }, (_, i) =>
                generated[1]!.lightened((1 - i / 3) * 0.4).darkened(i / 4))
            return [...water, ...land, ...clouds, ...atmosphere]
        }
        case 'Barren': {
            const colors = groundColors(generateColorscheme(count(rng, 3, 2), range(rng, 0.3, 0.6), 0.7, rng))
            return [...colors, colors[1]!, colors[2]!]
        }
        case 'Gas Giant': {
            const generated = generateColorscheme(count(rng, 8, 4), range(rng, 0.3, 0.8), 1, rng)
            const back = generated.slice(0, 4).map((color, i) => color.darkened(i / 6).darkened(0.7))
            const front = generated.slice(4, 8).map((color, i) => color.darkened(i / 4).lightened((1 - i / 4) * 0.5))
            return [...back, ...front]
        }
        case 'Ringed Gas Giant': {
            const generated = generateColorscheme(count(rng, 6, 4), range(rng, 0.3, 0.55), 1.4, rng)
            const colors = generated.slice(0, 6).map((color, i) => color.darkened(i / 7).lightened((1 - i / 6) * 0.3))
            return [...colors, ...colors]
        }
        case 'Ice World': {
            const generated = generateColorscheme(count(rng, 3, 2), range(rng, 0.7, 1), range(rng, 0.45, 0.55), rng)
            return terranFamily(generated, 3)
        }
        case 'Lava World': {
            const generated = generateColorscheme(count(rng, 2, 3), range(rng, 0.6, 1), range(rng, 0.7, 0.8), rng)
            const land = Array.from({ length: 3 }, (_, i) => shifted(generated[0]!.darkened(i / 3), 0.2 * (i / 4)))
            const lava = Array.from({ length: 3 }, (_, i) => shifted(generated[1]!.darkened(i / 3), 0.2 * (i / 3)))
            return [...land, land[1]!, land[2]!, ...lava]
        }
        case 'Asteroid':
            return groundColors(generateColorscheme(count(rng, 3, 2), range(rng, 0.3, 0.6), 0.7, rng))
        case 'Black Hole': {
            const generated = generateColorscheme(count(rng, 5, 2), range(rng, 0.3, 0.5), 2, rng)
            const colors = generated.slice(0, 5).map((color, i) =>
                color.darkened((i / 5) * 0.7).lightened((1 - i / 5) * 0.9))
            return [Color.fromHex('#272736'), colors[0]!, colors[3]!, ...colors]
        }
        case 'Galaxy': {
            const generated = generateColorscheme(6, range(rng, 0.5, 0.8), 1.4, rng)
            return ramp(generated, 7, 0.6)
        }
        case 'Standard Star': {
            const generated = generateColorscheme(4, range(rng, 0.2, 0.4), 2, rng)
            const colors = ramp(generated, 4 / 0.9, 0.8)
            colors[0] = colors[0]!.lightened(0.8)
            return [colors[0]!, ...colors, colors[1]!, colors[0]!]
        }
        default:
            throw new Error(`missing palette recipe for ${type}`)
    }
}

export const createPaletteController = (type: string, initialSeed: number, groups: TargetGroups): PaletteController => {
    const targets = groups.flat()
    const originals = targets.map((target) => target.read())
    let seed = initialSeed
    let rng = createRng(seed).next

    const colors = (): Color[] => targets.map((target) => target.read())
    const setColors = (next: readonly Color[]): void => {
        targets.forEach((target, index) => target.write(next[index] ?? Color.fromHex('#000000')))
    }

    return {
        colors,
        setColors,
        randomize: () => {
            const randomized = generateForType(type, rng)
            // Galaxy keeps its seventh headroom color because Godot only randomizes six entries.
            setColors(type === 'Galaxy' ? [...randomized, colors()[6]!] : randomized)
        },
        reset: () => { setColors(originals) },
        setSeed: (nextSeed) => {
            seed = nextSeed
            rng = createRng(seed).next
        },
    }
}
