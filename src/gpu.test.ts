import type { describe as describeFunction, expect as expectFunction, it as itFunction } from 'vitest'

declare const describe: typeof describeFunction
declare const expect: typeof expectFunction
declare const it: typeof itFunction

import { clampTextureLimit, FIREFOX_WEBGPU_FLOOR, routeBackend, TEXTURE_CEILING } from './gpu'

describe('texture ceiling', () => {
    it('caps any real device limit at 8192', () => {
        expect(TEXTURE_CEILING).toBe(8192)
        expect(clampTextureLimit(8192)).toBe(8192)
        expect(clampTextureLimit(16384)).toBe(8192)
        expect(clampTextureLimit(32768)).toBe(8192)
    })

    it('keeps a smaller device limit as is', () => {
        expect(clampTextureLimit(4096)).toBe(4096)
        expect(clampTextureLimit(2048.9)).toBe(2048)
    })

    it('falls back to the WebGL2 guaranteed minimum when nothing readable is reported', () => {
        for (const value of [undefined, null, Number.NaN, 0, -1, '8192']) expect(clampTextureLimit(value)).toBe(2048)
    })
})

describe('backend routing', () => {
    const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
    const firefox = (major: number): string => `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${major}.0) Gecko/20100101 Firefox/${major}.0`

    it('keeps Firefox below the floor on WebGL2 and lets 155+ try WebGPU', () => {
        expect(routeBackend('', firefox(153)).backend).toBe('webgl')
        expect(routeBackend('', firefox(154)).backend).toBe('webgl')
        expect(routeBackend('', firefox(FIREFOX_WEBGPU_FLOOR)).backend).toBe('webgpu')
        expect(routeBackend('', firefox(156)).backend).toBe('webgpu')
        expect(routeBackend('', chrome).backend).toBe('webgpu')
    })

    it('lets ?backend= override the version floor both ways', () => {
        expect(routeBackend('?backend=webgpu', firefox(153)).backend).toBe('webgpu')
        expect(routeBackend('?backend=webgl', firefox(156)).backend).toBe('webgl')
        expect(routeBackend('?backend=webgl', chrome).backend).toBe('webgl')
        expect(routeBackend('?backend=nonsense', firefox(153)).backend).toBe('webgl')
    })
})
