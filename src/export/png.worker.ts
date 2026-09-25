// Keeps this file a module so its Request and Response types stay local.
export {}

type Request =
    | { type: 'start', width: number, height: number }
    | { type: 'band', rows: Uint8Array, rowCount: number }
    | { type: 'finish' }
    | { type: 'cancel' }

type Response =
    | { type: 'ready' }
    | { type: 'progress', rows: number }
    | { type: 'chunk', chunk: Uint8Array }
    | { type: 'done' }
    | { type: 'error', message: string }

const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
let width = 0
let remainingRows = 0
let deflater: WritableStreamDefaultWriter<BufferSource> | null = null
let previous: Uint8Array | null = null
let canceled = false

const table = new Uint32Array(256)
for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? 0xEDB88320 ^ c >>> 1 : c >>> 1
    table[n] = c >>> 0
}

const crc32 = (type: Uint8Array, data: Uint8Array): number => {
    let crc = 0xFFFFFFFF
    for (const bytes of [type, data]) for (const byte of bytes) crc = table[(crc ^ byte) & 255]! ^ crc >>> 8
    return (crc ^ 0xFFFFFFFF) >>> 0
}

const chunk = (name: string, data: Uint8Array): Uint8Array => {
    const type = new TextEncoder().encode(name)
    const output = new Uint8Array(data.length + 12)
    const view = new DataView(output.buffer)
    view.setUint32(0, data.length)
    output.set(type, 4)
    output.set(data, 8)
    view.setUint32(data.length + 8, crc32(type, data))
    return output
}

const reply = (message: Response, transfer: Transferable[] = []): void => {
    self.postMessage(message, { transfer })
}

const paeth = (a: number, b: number, c: number): number => {
    const p = a + b - c
    const pa = Math.abs(p - a)
    const pb = Math.abs(p - b)
    const pc = Math.abs(p - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

const filteredRow = (row: Uint8Array): Uint8Array => {
    const candidates = Array.from({ length: 5 }, () => new Uint8Array(row.length + 1))
    const scores = new Float64Array(5)
    for (let filter = 0; filter < 5; filter += 1) candidates[filter]![0] = filter
    for (let x = 0; x < row.length; x += 1) {
        const value = row[x]!
        const left = x >= 4 ? row[x - 4]! : 0
        const above = previous?.[x] ?? 0
        const upperLeft = x >= 4 ? previous?.[x - 4] ?? 0 : 0
        const predictors = [0, left, above, Math.floor((left + above) / 2), paeth(left, above, upperLeft)]
        for (let filter = 0; filter < 5; filter += 1) {
            const encoded = (value - predictors[filter]! + 256) & 255
            candidates[filter]![x + 1] = encoded
            scores[filter] += Math.min(encoded, 256 - encoded)
        }
    }
    let best = 0
    for (let filter = 1; filter < 5; filter += 1) if (scores[filter]! < scores[best]!) best = filter
    previous = row.slice()
    return candidates[best]!
}

const send = (name: string, data: Uint8Array): void => {
    const bytes = chunk(name, data)
    reply({ type: 'chunk', chunk: bytes }, [bytes.buffer])
}

// Emits every compressed piece as its own IDAT, then IEND once the zlib stream closes.
const drain = async (reader: ReadableStreamDefaultReader<Uint8Array>, writer: WritableStreamDefaultWriter<BufferSource>): Promise<void> => {
    try {
        while (true) {
            const { done, value } = await reader.read()
            if (canceled || deflater !== writer) return
            if (done) break
            if (value.length > 0) send('IDAT', value)
        }
        send('IEND', new Uint8Array())
        reply({ type: 'done' })
    } catch (error) {
        if (!canceled && deflater === writer) reply({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
}

self.addEventListener('message', async (event: MessageEvent<Request>) => {
    try {
        const request = event.data
        if (request.type === 'cancel') {
            canceled = true
            const writer = deflater
            deflater = null
            await writer?.abort().catch(() => {})
            return
        }
        if (request.type === 'start') {
            width = request.width
            remainingRows = request.height
            previous = null
            canceled = false
            const header = new Uint8Array(13)
            const view = new DataView(header.buffer)
            view.setUint32(0, width)
            view.setUint32(4, request.height)
            header.set([8, 6, 0, 0, 0], 8)
            const start = new Uint8Array(signature.length + 25)
            start.set(signature)
            start.set(chunk('IHDR', header), signature.length)
            reply({ type: 'chunk', chunk: start }, [start.buffer])
            // The platform's zlib stream: fflate 0.8.3's streaming Zlib emitted invalid distances on long flat runs.
            const compressor = new CompressionStream('deflate')
            const writer = compressor.writable.getWriter()
            deflater = writer
            void drain(compressor.readable.getReader(), writer)
            reply({ type: 'ready' })
            return
        }
        if (!deflater || canceled) throw new Error('PNG encoder is not active.')
        if (request.type === 'band') {
            if (request.rows.length !== request.rowCount * width * 4 || request.rowCount > remainingRows) {
                throw new Error('PNG band dimensions do not match the image.')
            }
            const stride = width * 4
            const filtered = new Uint8Array(request.rowCount * (stride + 1))
            for (let rowIndex = 0; rowIndex < request.rowCount; rowIndex += 1) {
                const row = request.rows.subarray(rowIndex * stride, (rowIndex + 1) * stride)
                filtered.set(filteredRow(row), rowIndex * (stride + 1))
            }
            remainingRows -= request.rowCount
            await deflater.write(filtered)
            reply({ type: 'progress', rows: request.rowCount })
            return
        }
        if (remainingRows !== 0) throw new Error(`PNG encoder is missing ${remainingRows} rows.`)
        await deflater.close()
    } catch (error) {
        if (!canceled) reply({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
})
