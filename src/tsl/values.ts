import type { NoiseSpec } from './common'

/* Canonical Godot values for all twelve types, transcribed from the .tscn scenes and .gd
   scripts under .dev/refs/PixelPlanets-godot/Planets/. Godot wins every tie; never tune here. */

export type Vec2Tuple = readonly [number, number]
export type Vec4Tuple = readonly [number, number, number, number]

export interface LayerValues {
    node: string
    shader: string
    // Oversized-layer factories own this mesh scale and multiply shared planet pixels by it in-shader.
    quadScale: number
    pixels: number
    colors: readonly Vec4Tuple[]
    darkColors?: readonly Vec4Tuple[]
    /* The ONLY rotation field: the LAYER applies tilt + rotationOffset internally, exactly
       once; recipes pass bare tilt. Encodes the .gd runtime +0.7 (ring, disk) and
       the scene-tuned standing poses (land 0.2, Galaxy 0.674); absent = no offset. */
    rotationOffset?: number
    lightOrigin?: Vec2Tuple
    timeSpeed?: number
    // update_time scalar routed through get_multiplier; 0 = frozen or self-driven
    timeK?: number
    // Ring/Disk time is t·314.15·0.004 (RING_TIME_MULT), bypassing get_multiplier
    ringTime?: boolean
    size?: number
    octaves?: number
    noise?: NoiseSpec
    ditherSize?: number
    shouldDither?: boolean
    lightBorder1?: number
    lightBorder2?: number
    lightBorder?: number
    cloudCover?: number
    // set_seed rerolls cloud_cover in this range on every reseed
    cloudCoverRange?: Vec2Tuple
    stretch?: number
    cloudCurve?: number
    landCutoff?: number
    riverCutoff?: number
    lakeCutoff?: number
    lightDistance1?: number
    lightDistance2?: number
    nColors?: number
    bands?: number
    ringWidth?: number
    ringPerspective?: number
    scaleRelToPlanet?: number
    diskWidth?: number
    radius?: number
    lightWidth?: number
    tilt?: number
    nLayers?: number
    layerHeight?: number
    zoom?: number
    swirl?: number
    tiles?: number
    circleAmount?: number
    circleSize?: number
    circleScale?: number
    stormWidth?: number
    stormDitherWidth?: number
    scale?: number
}

export interface PlanetValues {
    // Derived from GUI.gd:19–32 labels; now project display strings used as registry and palette keys.
    name: string
    scene: string
    relativeScale: number
    guiZoom: number
    lightDrag: boolean
    // Layer node names whose should_dither the dither toggle writes (empty on Gas Giant)
    ditherLayers: readonly string[]
    // Empty when a one-layer body has no useful visibility toggle.
    layerMenu?: readonly number[]
    layers: readonly LayerValues[]
}

const MAIN = { hash: 15.5453 } as const
const DRY = { hash: 43758.5453 } as const

export const PLANETS = {
    terranWet: {
        name: 'Terran Wet',
        scene: 'Rivers/Rivers.tscn',
        relativeScale: 1.0,
        guiZoom: 1.0,
        lightDrag: true,
        ditherLayers: ['Land'],
        layers: [
            {
                node: 'Land', shader: 'Rivers/LandRivers.gdshader', quadScale: 1,
                pixels: 100.0, rotationOffset: 0.2, lightOrigin: [0.39, 0.39],
                timeSpeed: 0.1, timeK: 0.02, ditherSize: 3.951, shouldDither: true,
                lightBorder1: 0.287, lightBorder2: 0.476, riverCutoff: 0.368,
                size: 4.6, octaves: 6, noise: { ...MAIN, tiling: 'planet' },
                colors: [
                    [0.388235, 0.670588, 0.247059, 1], [0.231373, 0.490196, 0.309804, 1],
                    [0.184314, 0.341176, 0.32549, 1], [0.156863, 0.207843, 0.25098, 1],
                    [0.309804, 0.643137, 0.721569, 1], [0.25098, 0.286275, 0.45098, 1],
                ],
            },
            {
                node: 'Cloud', shader: 'LandMasses/Clouds.gdshader', quadScale: 1,
                pixels: 100.0, lightOrigin: [0.39, 0.39],
                timeSpeed: 0.1, timeK: 0.01,
                cloudCover: 0.47, cloudCoverRange: [0.35, 0.6], stretch: 2.0, cloudCurve: 1.3,
                lightBorder1: 0.52, lightBorder2: 0.62,
                size: 7.315, octaves: 2, noise: { ...MAIN, tiling: 'simple' },
                colors: [
                    [0.960784, 1, 0.909804, 1], [0.87451, 0.878431, 0.909804, 1],
                    [0.407843, 0.435294, 0.6, 1], [0.25098, 0.286275, 0.45098, 1],
                ],
            },
        ],
    },
    terranDry: {
        name: 'Terran Dry',
        scene: 'DryTerran/DryTerran.tscn',
        relativeScale: 1.0,
        guiZoom: 1.0,
        lightDrag: true,
        ditherLayers: ['Land'],
        layers: [
            {
                node: 'Land', shader: 'DryTerran/DryTerran.tscn (inline)', quadScale: 1,
                pixels: 100.0, lightOrigin: [0.4, 0.3],
                timeSpeed: 0.1, timeK: 0.02, ditherSize: 2.0, shouldDither: true,
                lightDistance1: 0.362, lightDistance2: 0.525, nColors: 5,
                size: 8.0, octaves: 3, noise: { ...DRY, tiling: 'planet' },
                colors: [
                    [1, 0.537255, 0.2, 1], [0.901961, 0.270588, 0.223529, 1],
                    [0.678431, 0.184314, 0.270588, 1], [0.321569, 0.2, 0.247059, 1],
                    [0.239216, 0.160784, 0.211765, 1],
                ],
            },
        ],
    },
    islands: {
        name: 'Islands',
        scene: 'LandMasses/LandMasses.tscn',
        relativeScale: 1.0,
        guiZoom: 1.0,
        lightDrag: true,
        ditherLayers: ['Water'],
        layers: [
            {
                node: 'Water', shader: 'LandMasses/PlanetUnder.gdshader', quadScale: 1,
                pixels: 100.0, lightOrigin: [0.39, 0.39],
                timeSpeed: 0.1, timeK: 0.02, ditherSize: 2.0, shouldDither: true,
                lightBorder1: 0.4, lightBorder2: 0.6,
                size: 5.228, octaves: 3, noise: { ...MAIN, tiling: 'planet' },
                colors: [
                    [0.572549, 0.909804, 0.752941, 1], [0.309804, 0.643137, 0.721569, 1],
                    [0.172549, 0.207843, 0.301961, 1],
                ],
            },
            {
                node: 'Land', shader: 'LandMasses/PlanetLandmass.gdshader', quadScale: 1,
                pixels: 100.0, rotationOffset: 0.2, lightOrigin: [0.39, 0.39],
                timeSpeed: 0.2, timeK: 0.02,
                lightBorder1: 0.32, lightBorder2: 0.534, landCutoff: 0.633,
                size: 4.292, octaves: 6, noise: { ...MAIN, tiling: 'planet' },
                colors: [
                    [0.784314, 0.831373, 0.364706, 1], [0.388235, 0.670588, 0.247059, 1],
                    [0.184314, 0.341176, 0.32549, 1], [0.156863, 0.207843, 0.25098, 1],
                ],
            },
            {
                node: 'Cloud', shader: 'LandMasses/Clouds.gdshader', quadScale: 1,
                pixels: 100.0, lightOrigin: [0.39, 0.39],
                timeSpeed: 0.47, timeK: 0.01,
                cloudCover: 0.415, cloudCoverRange: [0.35, 0.6], stretch: 2.0, cloudCurve: 1.3,
                lightBorder1: 0.52, lightBorder2: 0.62,
                size: 7.745, octaves: 2, noise: { ...MAIN, tiling: 'simple' },
                colors: [
                    [0.87451, 0.878431, 0.909804, 1], [0.639216, 0.654902, 0.760784, 1],
                    [0.407843, 0.435294, 0.6, 1], [0.25098, 0.286275, 0.45098, 1],
                ],
            },
        ],
    },
    noAtmosphere: {
        name: 'Barren',
        scene: 'NoAtmosphere/NoAtmosphere.tscn',
        relativeScale: 1.0,
        guiZoom: 1.0,
        lightDrag: true,
        ditherLayers: ['Ground'],
        layers: [
            {
                node: 'Ground', shader: 'NoAtmosphere/NoAtmosphere.gdshader', quadScale: 1,
                pixels: 100.0, lightOrigin: [0.25, 0.25],
                timeSpeed: 0.4, timeK: 0.02, ditherSize: 2.0, shouldDither: true,
                lightBorder1: 0.615, lightBorder2: 0.729,
                size: 8.0, octaves: 4, noise: { ...MAIN, tiling: 'simple' },
                colors: [
                    [0.639216, 0.654902, 0.760784, 1], [0.298039, 0.407843, 0.521569, 1],
                    [0.227451, 0.247059, 0.368627, 1],
                ],
            },
            {
                // pixels 87.419 is deliberately coarser than the ground's 100
                node: 'Craters', shader: 'NoAtmosphere/Craters.gdshader', quadScale: 1,
                pixels: 87.419, lightOrigin: [0.25, 0.25],
                timeSpeed: 0.001, timeK: 0.02, lightBorder: 0.465,
                size: 5.0, noise: { ...MAIN, tiling: 'simple' },
                colors: [
                    [0.298039, 0.407843, 0.521569, 1], [0.227451, 0.247059, 0.368627, 1],
                ],
            },
        ],
    },
    gasGiant1: {
        name: 'Gas Giant',
        scene: 'GasPlanet/GasPlanet.tscn',
        relativeScale: 1.0,
        guiZoom: 1.0,
        lightDrag: true,
        // GasPlanet.gd has no set_dither and its shader no should_dither; the toggle is a no-op
        ditherLayers: [],
        layers: [
            {
                node: 'Cloud', shader: 'GasPlanet/GasPlanet.gdshader', quadScale: 1,
                pixels: 100.0, lightOrigin: [0.25, 0.25],
                timeSpeed: 0.7, timeK: 0.005,
                cloudCover: 0.0, stretch: 1.0, cloudCurve: 1.3,
                // light_border_1 > light_border_2 is deliberate (inverted terminator)
                lightBorder1: 0.692, lightBorder2: 0.666,
                size: 9.0, octaves: 5, noise: { ...MAIN, tiling: 'simple' },
                colors: [
                    [0.231373, 0.12549, 0.152941, 1], [0.231373, 0.12549, 0.152941, 1],
                    [0, 0, 0, 1], [0.129412, 0.0941176, 0.105882, 1],
                ],
            },
            {
                node: 'Cloud2', shader: 'GasPlanet/GasPlanet.gdshader', quadScale: 1,
                pixels: 100.0, lightOrigin: [0.25, 0.25],
                timeSpeed: 0.47, timeK: 0.005,
                cloudCover: 0.538, cloudCoverRange: [0.28, 0.5], stretch: 1.0, cloudCurve: 1.3,
                lightBorder1: 0.439, lightBorder2: 0.746,
                size: 9.0, octaves: 5, noise: { ...MAIN, tiling: 'simple' },
                colors: [
                    [0.941176, 0.709804, 0.254902, 1], [0.811765, 0.458824, 0.168627, 1],
                    [0.670588, 0.317647, 0.188235, 1], [0.490196, 0.219608, 0.2, 1],
                ],
            },
        ],
    },
    gasGiant2: {
        name: 'Ringed Gas Giant',
        scene: 'GasPlanetLayers/GasPlanetLayers.tscn',
        relativeScale: 3.0,
        guiZoom: 2.5,
        lightDrag: true,
        ditherLayers: ['GasLayers'],
        layers: [
            {
                node: 'GasLayers', shader: 'GasPlanetLayers/GasLayers.gdshader', quadScale: 1,
                pixels: 100.0, lightOrigin: [-0.1, 0.3],
                timeSpeed: 0.05, timeK: 0.004,
                cloudCover: 0.61, stretch: 2.204, cloudCurve: 1.376,
                lightBorder1: 0.52, lightBorder2: 0.62, bands: 0.892,
                shouldDither: true, nColors: 3,
                size: 10.107, octaves: 3, noise: { ...MAIN, tiling: 'planet' },
                colors: [
                    [0.933333, 0.764706, 0.603922, 1], [0.85098, 0.627451, 0.4, 1],
                    [0.560784, 0.337255, 0.231373, 1],
                ],
                darkColors: [
                    [0.4, 0.223529, 0.192157, 1], [0.270588, 0.156863, 0.235294, 1],
                    [0.133333, 0.12549, 0.203922, 1],
                ],
            },
            {
                node: 'Ring', shader: 'GasPlanetLayers/Ring.gdshader', quadScale: 3,
                pixels: 300.0, rotationOffset: 0.7, lightOrigin: [-0.1, 0.3],
                timeSpeed: 0.2, ringTime: true,
                lightBorder1: 0.52, lightBorder2: 0.62,
                ringWidth: 0.127, ringPerspective: 6.0, scaleRelToPlanet: 6.0, nColors: 3,
                size: 15.0, octaves: 4, noise: { ...MAIN, tiling: 'planet' },
                colors: [
                    [0.933333, 0.764706, 0.603922, 1], [0.701961, 0.478431, 0.313726, 1],
                    [0.560784, 0.337255, 0.231373, 1],
                ],
                darkColors: [
                    [0.333333, 0.188235, 0.211765, 1], [0.196078, 0.137255, 0.215686, 1],
                    [0.133333, 0.12549, 0.203922, 1],
                ],
            },
        ],
    },
    iceWorld: {
        name: 'Ice World',
        scene: 'IceWorld/IceWorld.tscn',
        relativeScale: 1.0,
        guiZoom: 1.0,
        lightDrag: true,
        ditherLayers: ['Land'],
        layers: [
            {
                node: 'Land', shader: 'LandMasses/PlanetUnder.gdshader', quadScale: 1,
                pixels: 100.0, lightOrigin: [0.3, 0.3],
                timeSpeed: 0.25, timeK: 0.02, ditherSize: 2.0, shouldDither: true,
                lightBorder1: 0.48, lightBorder2: 0.632,
                size: 8.0, octaves: 2, noise: { ...MAIN, tiling: 'planet' },
                colors: [
                    [0.980392, 1, 1, 1], [0.780392, 0.831373, 0.882353, 1],
                    [0.572549, 0.560784, 0.721569, 1],
                ],
            },
            {
                // Near-zero light borders on purpose: the lakes read as almost unlit
                node: 'Lakes', shader: 'IceWorld/IceWorld.tscn (inline)', quadScale: 1,
                pixels: 100.0, lightOrigin: [0.3, 0.3],
                timeSpeed: 0.2, timeK: 0.02,
                lightBorder1: 0.024, lightBorder2: 0.047, lakeCutoff: 0.55,
                size: 10.0, octaves: 3, noise: { ...DRY, tiling: 'planet' },
                colors: [
                    [0.309804, 0.643137, 0.721569, 1], [0.298039, 0.407843, 0.521569, 1],
                    [0.227451, 0.247059, 0.368627, 1],
                ],
            },
            {
                node: 'Clouds', shader: 'LandMasses/Clouds.gdshader', quadScale: 1,
                pixels: 100.0, lightOrigin: [0.3, 0.3],
                timeSpeed: 0.1, timeK: 0.01,
                cloudCover: 0.546, stretch: 2.5, cloudCurve: 1.3,
                lightBorder1: 0.566, lightBorder2: 0.781,
                size: 4.0, octaves: 4, noise: { ...MAIN, tiling: 'simple' },
                colors: [
                    [0.882353, 0.94902, 1, 1], [0.752941, 0.890196, 1, 1],
                    [0.368627, 0.439216, 0.647059, 1], [0.25098, 0.286275, 0.45098, 1],
                ],
            },
        ],
    },
    lavaWorld: {
        name: 'Lava World',
        scene: 'LavaWorld/LavaWorld.tscn',
        relativeScale: 1.0,
        guiZoom: 1.0,
        lightDrag: true,
        ditherLayers: ['Land'],
        layers: [
            {
                node: 'Land', shader: 'NoAtmosphere/NoAtmosphere.gdshader', quadScale: 1,
                pixels: 100.0, lightOrigin: [0.3, 0.3],
                timeSpeed: 0.2, timeK: 0.02, ditherSize: 2.0, shouldDither: true,
                lightBorder1: 0.4, lightBorder2: 0.6,
                size: 10.0, octaves: 3, noise: { ...MAIN, tiling: 'simple' },
                colors: [
                    [0.560784, 0.301961, 0.341176, 1], [0.321569, 0.2, 0.247059, 1],
                    [0.239216, 0.160784, 0.211765, 1],
                ],
            },
            {
                node: 'Craters', shader: 'NoAtmosphere/Craters.gdshader', quadScale: 1,
                pixels: 100.0, lightOrigin: [0.3, 0.3],
                timeSpeed: 0.2, timeK: 0.02, lightBorder: 0.4,
                size: 3.5, noise: { ...MAIN, tiling: 'simple' },
                colors: [
                    [0.321569, 0.2, 0.247059, 1], [0.239216, 0.160784, 0.211765, 1],
                ],
            },
            {
                // Near-zero light borders on purpose: lava self-illuminates
                node: 'LavaRivers', shader: 'LavaWorld/Rivers.gdshader', quadScale: 1,
                pixels: 100.0, lightOrigin: [0.3, 0.3],
                timeSpeed: 0.2, timeK: 0.02,
                lightBorder1: 0.019, lightBorder2: 0.036, riverCutoff: 0.579,
                size: 10.0, octaves: 4, noise: { ...MAIN, tiling: 'planet' },
                colors: [
                    [1, 0.537255, 0.2, 1], [0.901961, 0.270588, 0.223529, 1],
                    [0.678431, 0.184314, 0.270588, 1],
                ],
            },
        ],
    },
    asteroid: {
        name: 'Asteroid',
        scene: 'Asteroids/Asteroid.tscn',
        relativeScale: 1.0,
        guiZoom: 1.0,
        lightDrag: true,
        ditherLayers: ['Asteroid'],
        layers: [
            {
                // update_time is a no-op; set_custom_time spins via rotation = t·2π instead
                node: 'Asteroid', shader: 'Asteroids/Asteroids.gdshader', quadScale: 1,
                pixels: 100.0, lightOrigin: [0, 0],
                timeSpeed: 0.4, timeK: 0, shouldDither: true,
                size: 5.294, octaves: 2, noise: { ...MAIN, tiling: 'none' },
                colors: [
                    [0.639216, 0.654902, 0.760784, 1], [0.298039, 0.407843, 0.521569, 1],
                    [0.227451, 0.247059, 0.368627, 1],
                ],
            },
        ],
    },
    blackHole: {
        name: 'Black Hole',
        scene: 'BlackHole/BlackHole.tscn',
        relativeScale: 2.0,
        guiZoom: 2.0,
        lightDrag: false,
        ditherLayers: ['Disk'],
        layers: [
            {
                // Purely radial: no noise, no time, no rotation, no seed
                node: 'BlackHole', shader: 'BlackHole/BlackHole.gdshader', quadScale: 1,
                pixels: 100.0, radius: 0.247, lightWidth: 0.028,
                colors: [
                    [0.152941, 0.152941, 0.211765, 1], [1, 1, 0.921569, 1],
                    [0.929412, 0.482353, 0.223529, 1],
                ],
            },
            {
                node: 'Disk', shader: 'BlackHole/BlackHoleRing.gdshader', quadScale: 3,
                // Scene rotation 0.766 is dead tuning; runtime is always sharedRotation + 0.7
                pixels: 300.0, rotationOffset: 0.7, lightOrigin: [0.607, 0.444],
                timeSpeed: 0.2, ringTime: true, shouldDither: true,
                diskWidth: 0.065, ringPerspective: 14.0, nColors: 5,
                size: 6.598, octaves: 3, noise: { ...MAIN, tiling: 'planet' },
                colors: [
                    [1, 1, 0.921569, 1], [1, 0.960784, 0.25098, 1], [1, 0.721569, 0.290196, 1],
                    [0.929412, 0.482353, 0.223529, 1], [0.741176, 0.25098, 0.207843, 1],
                ],
            },
        ],
    },
    galaxy: {
        name: 'Galaxy',
        scene: 'Galaxy/Galaxy.tscn',
        relativeScale: 1.0,
        guiZoom: 2.5,
        lightDrag: false,
        ditherLayers: ['Galaxy'],
        layerMenu: [],
        layers: [
            {
                // colors[6] is a deliberate headroom slot beyond n_colors, reachable via the clamp
                node: 'Galaxy', shader: 'Galaxy/Galaxy.gdshader', quadScale: 1,
                pixels: 200.0, rotationOffset: 0.674,
                timeSpeed: 1.0, timeK: 0.04, ditherSize: 2.0, shouldDither: true,
                nColors: 6, tilt: 3.0, nLayers: 4.0, layerHeight: 0.4, zoom: 1.375, swirl: -9.0,
                size: 7.0, octaves: 1, noise: { ...MAIN, tiling: 'none' },
                colors: [
                    [1, 1, 0.921569, 1], [1, 0.913725, 0.552941, 1], [0.709804, 0.878431, 0.4, 1],
                    [0.396078, 0.647059, 0.4, 1], [0.223529, 0.364706, 0.392157, 1],
                    [0.196078, 0.223529, 0.301961, 1], [0.196078, 0.160784, 0.278431, 1],
                ],
            },
        ],
    },
    star: {
        name: 'Standard Star',
        scene: 'Star/Star.tscn',
        relativeScale: 2.0,
        guiZoom: 2.0,
        lightDrag: false,
        ditherLayers: ['Star', 'StarFlares'],
        layers: [
            {
                node: 'Blobs', shader: 'Star/StarBlobs.gdshader', quadScale: 2,
                pixels: 200.0,
                timeSpeed: 0.05, timeK: 0.01,
                circleAmount: 2.0, circleSize: 1.0,
                size: 4.93, octaves: 4, noise: { ...MAIN, tiling: 'simple' },
                colors: [[1, 1, 0.894118, 1]],
            },
            {
                node: 'Star', shader: 'Star/Star.gdshader', quadScale: 1,
                pixels: 100.0,
                timeSpeed: 0.05, timeK: 0.005, shouldDither: true,
                nColors: 4, tiles: 1.0,
                size: 4.463, octaves: 4, noise: { ...MAIN, tiling: 'simple' },
                colors: [
                    [0.960784, 1, 0.909804, 1], [0.466667, 0.839216, 0.756863, 1],
                    [0.109804, 0.572549, 0.654902, 1], [0.0117647, 0.243137, 0.368627, 1],
                ],
            },
            {
                // storm_dither_width 0.0 deliberately overrides the shader default 0.07
                node: 'StarFlares', shader: 'Star/StarFlares.gdshader', quadScale: 2,
                pixels: 200.0,
                timeSpeed: 0.05, timeK: 0.015, shouldDither: true,
                stormWidth: 0.3, stormDitherWidth: 0.0, scale: 1.0,
                circleAmount: 2.0, circleScale: 1.0,
                size: 1.6, octaves: 4, noise: { ...MAIN, tiling: 'simple' },
                colors: [[0.466667, 0.839216, 0.756863, 1], [1, 1, 0.894118, 1]],
            },
        ],
    },
} as const satisfies Record<string, PlanetValues>

export type PlanetTypeId = keyof typeof PLANETS
