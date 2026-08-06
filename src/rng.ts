/* Mulberry32, ported from Cosmorph so seeds behave identically; `seed | 0` (not >>> 0) is critical! */
export interface Rng {
    next: () => number
    gauss: () => number
}

export function createRng(seed: number): Rng {
    let s = seed | 0
    function next(): number {
        s |= 0; s = s + 0x6D2B79F5 | 0
        let t = Math.imul(s ^ s >>> 15, 1 | s)
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
        return ((t ^ t >>> 14) >>> 0) / 4294967296
    }
    function gauss(): number {
        let u: number
        do { u = next() } while (u === 0)
        const v = next()
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
    }
    return { next, gauss }
}

/* Stable per-entity sub-seed so rerolling one entity never disturbs another */
export function deriveSeed(rootSeed: number, salt: number): number {
    const rng = createRng((rootSeed ^ Math.imul(salt, 0x9E3779B1)) | 0)
    return Math.floor(rng.next() * 0x7FFFFFFF)
}

/* Godot's seed conversion, verbatim from every planet's set_seed: one converted seed in
   [0, 10) fanned to all layers. sd % 1000 < ~7 degenerates the sin-hash (Godot ships that). */
export function convertSeed(sd: number): number {
    return (sd % 1000) / 100
}
