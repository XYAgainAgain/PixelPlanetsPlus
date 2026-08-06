import { Mesh, MeshBasicNodeMaterial, PlaneGeometry } from 'three/webgpu'
import { Fn, abs, cos, fract, sin, uniform, uv, vec2, vec4 } from 'three/tsl'

export const createGradientBackground = (): {
    mesh: Mesh
    updateTime: (time: number) => void
} => {
    const rotationPhase = uniform(0)
    const redPhase = uniform(0)
    const greenPhase = uniform(0)
    const bluePhase = uniform(0)
    const noisePhase = uniform(0)
    const fragment = Fn(() => {
        const sourceUv = uv().toVar()
        const centered = sourceUv.sub(0.5).toVar()
        const rotated = vec2(
            centered.x.mul(cos(rotationPhase)).sub(centered.y.mul(sin(rotationPhase))),
            centered.x.mul(sin(rotationPhase)).add(centered.y.mul(cos(rotationPhase))),
        ).add(0.5).toVar()
        const noise = fract(sin(sourceUv.dot(vec2(12.9898, 78.233)).add(noisePhase)).mul(43758.5453))
        const brightness = noise.mul(0.03).add(1).mul(1 - 0.831373)

        return vec4(
            abs(sin(rotated.x.add(redPhase))).mul(brightness),
            abs(sin(cos(rotated.x.add(rotated.y)).add(1).add(greenPhase))).mul(brightness),
            abs(cos(bluePhase)).mul(brightness),
            1,
        )
    })

    const material = new MeshBasicNodeMaterial({ depthTest: false, depthWrite: false })
    material.fragmentNode = fragment()
    const mesh = new Mesh(new PlaneGeometry(1, 1), material)
    mesh.position.z = -1
    mesh.renderOrder = -200
    return {
        mesh,
        updateTime: (time) => {
            const turn = Math.PI * 2
            rotationPhase.value = (time * 0.2) % turn
            redPhase.value = (time * 0.105) % turn
            greenPhase.value = (time * 0.059) % turn
            bluePhase.value = (time * 0.0253) % turn
            noisePhase.value = (time * 0.0000001 * 12.9898) % turn
        },
    }
}
