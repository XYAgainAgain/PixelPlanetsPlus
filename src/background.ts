import {
    Group, Mesh, MeshBasicNodeMaterial, NearestFilter, PerspectiveCamera, PlaneGeometry,
    RenderTarget, Scene, Sprite, SpriteNodeMaterial, Texture, TextureLoader, WebGPURenderer,
} from 'three/webgpu'
import { createRng, deriveSeed, type Rng } from './rng'
import { createGradientBackground } from './tsl/backgroundGradient'

export const BACKGROUND_MODES = ['None', 'Stars', 'Gradient', 'Stars on Gradient'] as const
export type BackgroundMode = typeof BACKGROUND_MODES[number]

const STAR_COUNT = 1000
const STAR_SEED_SALT = 0x53544152
const loader = new TextureLoader()
const starTextures = Promise.all([
    loader.loadAsync(new URL('./stars/stars.png', import.meta.url).href),
    loader.loadAsync(new URL('./stars/stars-special.png', import.meta.url).href),
])

const integer = (rng: Rng, min: number, max: number): number =>
    Math.floor(rng.next() * (max - min + 1) + min)

const spriteTexture = (source: Texture, special: boolean, frame: number): Texture => {
    const texture = source.clone()
    texture.magFilter = NearestFilter
    texture.minFilter = NearestFilter
    texture.repeat.x = special ? 1 / 6 : 1 / 17
    texture.offset.x = special ? frame * 25 / 150 : frame * 9 / 144
    texture.needsUpdate = true
    return texture
}

interface StarPool {
    materials: Map<string, SpriteNodeMaterial>
    textures: Texture[]
}

const createStarPool = (starTexture: Texture, specialTexture: Texture): StarPool => {
    const materials = new Map<string, SpriteNodeMaterial>()
    const textures: Texture[] = []
    for (const special of [false, true]) {
        const frameCount = special ? 6 : 9
        for (let frame = 0; frame < frameCount; frame += 1) {
            const texture = spriteTexture(special ? specialTexture : starTexture, special, frame)
            textures.push(texture)
            for (const color of ['#ffef9e', '#ffffff']) {
                materials.set(`${Number(special)}:${frame}:${color}`, new SpriteNodeMaterial({
                    map: texture,
                    color,
                    transparent: true,
                    opacity: 1,
                    depthTest: false,
                    depthWrite: false,
                }))
            }
        }
    }
    return { materials, textures }
}

const populateStars = (group: Group, pool: StarPool, seed: number): void => {
    const rng = createRng(deriveSeed(seed, STAR_SEED_SALT))

    for (let i = 0; i < STAR_COUNT; i += 1) {
        const special = rng.next() > 0.5
        const frame = special ? integer(rng, 1, 6) % 6 : integer(rng, 1, 17) % 9
        const color = rng.next() > 0.5 ? '#ffef9e' : '#ffffff'
        const opacity = integer(rng, 0.1, 1)
        const longitude = 2 * Math.PI * rng.next()
        const polar = Math.acos(2 * rng.next() - 1)
        if (opacity === 0) continue
        const material = pool.materials.get(`${Number(special)}:${frame}:${color}`)
        if (!material) throw new Error('missing star material variant')
        const star = new Sprite(material)
        const scale = special ? 0.05 : 0.03
        star.scale.set(scale, scale, 1)
        star.position.set(
            Math.sin(polar) * Math.cos(longitude),
            Math.sin(polar) * Math.sin(longitude),
            Math.cos(polar),
        )
        star.renderOrder = -100
        group.add(star)
    }
}

const disposeStars = (group: Group): void => {
    group.clear()
}

export interface BackgroundRuntime {
    group: Group
    mode: BackgroundMode
    reseed: (seed: number) => void
    resize: (width: number, height: number, pixels: number) => void
    renderStars: (renderer: WebGPURenderer) => void
    update: (time: number, delta: number) => void
    dispose: () => void
}

export const createBackground = (mode: BackgroundMode, seed: number): BackgroundRuntime => {
    const group = new Group()
    let stars: Group | null = null
    let starPool: StarPool | null = null
    let starSeed = seed
    let disposed = false
    let starRenderFailed = false
    const hasStars = mode === 'Stars' || mode === 'Stars on Gradient'
    const gradient = mode === 'Gradient' || mode === 'Stars on Gradient' ? createGradientBackground() : null
    const starScene = hasStars ? new Scene() : null
    const starCamera = hasStars ? new PerspectiveCamera(75, 1, 0.1, 100000) : null
    const starTarget = hasStars ? new RenderTarget(256, 256, { depthBuffer: false }) : null
    const starComposite = starTarget
        ? new Mesh(new PlaneGeometry(1, 1), new MeshBasicNodeMaterial({
            map: starTarget.texture,
            transparent: true,
            depthTest: false,
            depthWrite: false,
        }))
        : null
    if (hasStars && starScene && starCamera && starTarget && starComposite) {
        starTarget.texture.magFilter = NearestFilter
        starTarget.texture.minFilter = NearestFilter
        starCamera.position.z = 1
        stars = new Group()
        stars.renderOrder = -100
        starScene.add(stars)
        starComposite.position.z = -0.99
        starComposite.renderOrder = -100
        void starTextures.then(([starTexture, specialTexture]) => {
            if (disposed || !stars) return
            starPool = createStarPool(starTexture, specialTexture)
            populateStars(stars, starPool, starSeed)
        }).catch((error: unknown) => { console.error('Star textures failed to load.', error) })
    }
    if (gradient) group.add(gradient.mesh)
    if (starComposite) group.add(starComposite)

    return {
        group,
        mode,
        reseed: (nextSeed) => {
            if (!stars) return
            starSeed = nextSeed
            disposeStars(stars)
            if (starPool) populateStars(stars, starPool, nextSeed)
        },
        resize: (width, height, pixels) => {
            const viewHeight = 4 * Math.tan((75 * Math.PI) / 360)
            const aspect = width / height
            gradient?.mesh.scale.set(viewHeight * aspect, viewHeight, 1)
            starComposite?.scale.set(viewHeight * aspect, viewHeight, 1)
            if (starCamera && starTarget) {
                starCamera.aspect = aspect
                starCamera.updateProjectionMatrix()
                const resolution = Math.max(128, Math.min(1024, Math.round(pixels)))
                starTarget.setSize(resolution, resolution)
            }
        },
        renderStars: (renderer) => {
            if (!starScene || !starCamera || !starTarget || starRenderFailed) return
            try {
                renderer.setRenderTarget(starTarget)
                renderer.setClearColor(0x000000, 0)
                renderer.render(starScene, starCamera)
            } catch (error: unknown) {
                starRenderFailed = true
                console.error('Starfield rendering failed; continuing without stars.', error)
            } finally {
                renderer.setRenderTarget(null)
                renderer.setClearColor(0x000000, 1)
            }
        },
        update: (time, delta) => {
            gradient?.updateTime(time)
            if (stars) {
                stars.rotation.x += delta * 0.0006
                stars.rotation.y += delta * 0.0006
                stars.rotation.z += delta * 0.0006
            }
        },
        dispose: () => {
            disposed = true
            if (stars) disposeStars(stars)
            if (starPool) {
                for (const material of starPool.materials.values()) material.dispose()
                for (const texture of starPool.textures) texture.dispose()
            }
            starTarget?.dispose()
            starComposite?.geometry.dispose()
            starComposite?.material.dispose()
            gradient?.mesh.geometry.dispose()
            if (gradient) {
                const materials = Array.isArray(gradient.mesh.material) ? gradient.mesh.material : [gradient.mesh.material]
                for (const material of materials) material.dispose()
            }
            group.removeFromParent()
        },
    }
}
