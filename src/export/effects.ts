import type { ExportEffectV1, SceneRecipeV2 } from './types'

export const CHROMATIC_ABERRATION_ID = 'chromaticAberration'
export const CHROMATIC_ABERRATION_VERSION = 1
// The live filter shifts red and blue by 0.001 of the stage width (index.html, GUI.tscn's post shader).
export const CHROMATIC_ABERRATION_FRACTION = 0.001
/* Below this width the shift rounds to 0 whole pixels, and a sub-pixel split would smear the pixel art,
   so the effect is unavailable (never silently dropped: the composer shows it as off, with the reason). */
export const CHROMATIC_ABERRATION_MIN_WIDTH = 500

export const isChromaticAberration = (effect: ExportEffectV1): boolean =>
    effect.id === CHROMATIC_ABERRATION_ID && effect.version === CHROMATIC_ABERRATION_VERSION

/* The one entry the checkbox, the exporter, and the codec's flag bits all mean: a single parameterless v1.
   Duplicates or parameters are some other writer's data, left untouched and never applied. */
export const canonicalChromaticAberration = (effects: readonly ExportEffectV1[]): ExportEffectV1 | null => {
    const entries = effects.filter(isChromaticAberration)
    return entries.length === 1 && Object.keys(entries[0]!.parameters).length === 0 ? entries[0]! : null
}

export const hasNoncanonicalChromaticAberration = (effects: readonly ExportEffectV1[]): boolean =>
    effects.some(isChromaticAberration) && canonicalChromaticAberration(effects) === null

export const chromaticAberrationSetting = (effects: readonly ExportEffectV1[]): boolean | null =>
    canonicalChromaticAberration(effects)?.enabled ?? null

// Sets the canonical entry (appended last when new); a noncanonical list is returned unchanged.
export const withChromaticAberration = (effects: readonly ExportEffectV1[], enabled: boolean): ExportEffectV1[] => {
    if (hasNoncanonicalChromaticAberration(effects)) return [...effects]
    return [
        ...effects.filter((effect) => !isChromaticAberration(effect)),
        { id: CHROMATIC_ABERRATION_ID, version: CHROMATIC_ABERRATION_VERSION, enabled, parameters: {} },
    ]
}

// Whole output pixels of shift for an image this wide; 0 means the effect cannot apply.
export const chromaticAberrationOffset = (width: number): number =>
    Math.round(width * CHROMATIC_ABERRATION_FRACTION)

// The shift an export of this width actually applies: 0 when the recipe leaves CA off or the image is too narrow.
export const effectiveChromaticAberration = (recipe: SceneRecipeV2, width: number): number =>
    chromaticAberrationSetting(recipe.effects) === true ? chromaticAberrationOffset(width) : 0

/* Red shifts right and blue left, like the live SVG filter. Alpha never changes so sprite silhouettes survive;
   borrowed channels fade by the alpha ratio, and edge samples clamp so no colored border appears. */
export const applyChromaticAberration = (
    pixels: Uint8ClampedArray,
    width: number,
    rows: number,
    offset: number,
): void => {
    if (offset <= 0 || width <= 0) return
    const row = new Uint8ClampedArray(width * 4)
    for (let y = 0; y < rows; y += 1) {
        const start = y * width * 4
        row.set(pixels.subarray(start, start + width * 4))
        for (let x = 0; x < width; x += 1) {
            const target = start + x * 4
            const alpha = row[x * 4 + 3]!
            if (alpha === 0) continue
            const redFrom = Math.min(width - 1, x + offset) * 4
            const blueFrom = Math.max(0, x - offset) * 4
            pixels[target] = Math.round(row[redFrom]! * Math.min(row[redFrom + 3]!, alpha) / alpha)
            pixels[target + 2] = Math.round(row[blueFrom + 2]! * Math.min(row[blueFrom + 3]!, alpha) / alpha)
        }
    }
}
