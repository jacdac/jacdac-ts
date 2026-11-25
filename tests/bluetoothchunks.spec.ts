import { strict as assert } from "assert"
import {
    BluetoothChunkReassembler,
    toBluetoothChunks,
} from "../src/jdom/transport/bluetoothchunks"

function frameOf(length: number, seed = 0) {
    const frame = new Uint8Array(length)
    for (let i = 0; i < length; ++i) frame[i] = (i * 7 + seed) & 0xff
    return frame
}

function headers(chunks: Uint8Array[]) {
    return chunks.map(c => [c[0], c[1], c.length])
}

// port of JacdacBLE::send() in pxt-jacdac, the reference for the wire format
function firmwareChunks(frame: Uint8Array) {
    const total = Math.ceil(frame.length / 18)
    let remaining = total - 1
    let sent = 0
    const chunks: Uint8Array[] = []
    while (sent < frame.length) {
        const n = Math.min(18, frame.length - sent)
        const chunk = new Uint8Array(n + 2)
        chunk[0] = (total & 0x7f) | (sent == 0 ? 0x80 : 0)
        chunk[1] = remaining
        chunk.set(frame.subarray(sent, sent + n), 2)
        chunks.push(chunk)
        sent += n
        remaining = remaining == 0 ? 0 : remaining - 1
    }
    return chunks
}

describe("bluetooth chunks", () => {
    it("splits a frame into 20 byte chunks with headers", () => {
        const chunks = toBluetoothChunks(frameOf(40))
        assert.deepEqual(headers(chunks), [
            [0x83, 2, 20],
            [0x03, 1, 20],
            [0x03, 0, 6],
        ])
    })

    it("matches the firmware's chunking byte for byte", () => {
        for (const n of [1, 12, 17, 18, 19, 36, 37, 100, 252]) {
            const frame = frameOf(n, n)
            assert.deepEqual(toBluetoothChunks(frame), firmwareChunks(frame))
        }
    })

    it("sends nothing for an empty frame", () => {
        assert.deepEqual(toBluetoothChunks(new Uint8Array(0)), [])
    })

    it("rejects frames that need more than 127 chunks", () => {
        assert.throws(() => toBluetoothChunks(frameOf(127 * 18 + 1)))
        assert.equal(toBluetoothChunks(frameOf(127 * 18)).length, 127)
    })

    it("reassembles frames of any size", () => {
        const r = new BluetoothChunkReassembler()
        for (const n of [1, 17, 18, 19, 36, 37, 100, 252]) {
            const frame = frameOf(n, n)
            const chunks = toBluetoothChunks(frame)
            chunks.slice(0, -1).forEach(c => assert.equal(r.push(c), undefined))
            assert.deepEqual(r.push(chunks[chunks.length - 1]), frame)
        }
        assert.equal(r.droppedFrames, 0)
        assert.equal(r.strayChunks, 0)
    })

    it("reassembles frames chunked by the firmware", () => {
        const r = new BluetoothChunkReassembler()
        const frame = frameOf(77, 3)
        let out: Uint8Array | undefined
        for (const c of firmwareChunks(frame)) out = r.push(c)
        assert.deepEqual(out, frame)
    })

    it("ignores a non-first chunk with no frame in progress", () => {
        const r = new BluetoothChunkReassembler()
        const chunks = toBluetoothChunks(frameOf(40))
        assert.equal(r.push(chunks[1]), undefined)
        assert.equal(r.push(chunks[2]), undefined)
        assert.equal(r.strayChunks, 2)
        assert.equal(r.droppedFrames, 0)
    })

    it("drops a frame with a missing chunk and recovers", () => {
        const r = new BluetoothChunkReassembler()
        const a = toBluetoothChunks(frameOf(54, 1)) // 3 chunks
        const b = frameOf(30, 2)
        assert.equal(r.push(a[0]), undefined)
        assert.equal(r.push(a[2]), undefined) // a[1] lost
        assert.equal(r.droppedFrames, 1)
        let out: Uint8Array | undefined
        for (const c of toBluetoothChunks(b)) out = r.push(c)
        assert.deepEqual(out, b)
    })

    it("drops a frame with a duplicated chunk", () => {
        const r = new BluetoothChunkReassembler()
        const a = toBluetoothChunks(frameOf(54, 1))
        r.push(a[0])
        r.push(a[1])
        assert.equal(r.push(a[1]), undefined)
        assert.equal(r.push(a[2]), undefined)
        assert.equal(r.droppedFrames, 1)
    })

    it("drops an unfinished frame when a new one starts", () => {
        const r = new BluetoothChunkReassembler()
        const a = toBluetoothChunks(frameOf(54, 1))
        const b = frameOf(20, 2)
        r.push(a[0])
        let out: Uint8Array | undefined
        for (const c of toBluetoothChunks(b)) out = r.push(c)
        assert.deepEqual(out, b)
        assert.equal(r.droppedFrames, 1)
    })

    it("never delivers a partial frame from interleaved chunks", () => {
        const r = new BluetoothChunkReassembler()
        const a = frameOf(54, 1)
        const b = frameOf(54, 2)
        const ca = toBluetoothChunks(a)
        const cb = toBluetoothChunks(b)
        const delivered = [ca[0], cb[0], ca[1], cb[1], ca[2], cb[2]]
            .map(c => r.push(c))
            .filter((f): f is Uint8Array => !!f)
        for (const f of delivered)
            assert.ok(
                f.length == a.length &&
                    (f.every((v, i) => v == a[i]) ||
                        f.every((v, i) => v == b[i]))
            )
    })

    it("ignores chunks shorter than the header", () => {
        const r = new BluetoothChunkReassembler()
        const a = toBluetoothChunks(frameOf(40))
        r.push(a[0])
        assert.equal(r.push(new Uint8Array([0x03])), undefined)
        assert.equal(r.droppedFrames, 1)
        assert.equal(r.push(a[1]), undefined)
        assert.equal(r.strayChunks, 1)
    })

    it("drops a first chunk with an inconsistent header", () => {
        const r = new BluetoothChunkReassembler()
        assert.equal(r.push(new Uint8Array([0x83, 0, 1, 2])), undefined)
        assert.equal(r.push(new Uint8Array([0x80, 0, 1, 2])), undefined)
        assert.equal(r.droppedFrames, 2)
    })
})
