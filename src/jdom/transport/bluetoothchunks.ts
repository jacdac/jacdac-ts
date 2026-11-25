/**
 * Chunking of Jacdac frames for the Jacdac Bluetooth LE service.
 *
 * The default ATT MTU of 23 leaves 20 bytes per write/notification. Each chunk is
 *
 *   byte 0: total number of chunks of the frame (7 bits), | 0x80 on the first chunk
 *   byte 1: number of chunks remaining after this one (total - 1 ... 0)
 *   byte 2..19: up to 18 bytes of the frame
 *
 * This matches JacdacBLE.cpp in pxt-jacdac (micro:bit V2 / Calliope mini 3).
 */

export const BLUETOOTH_CHUNK_HEADER_SIZE = 2
export const BLUETOOTH_CHUNK_DATA_SIZE = 18
export const BLUETOOTH_CHUNK_FIRST_FLAG = 0x80
export const BLUETOOTH_CHUNK_MAX_CHUNKS = 0x7f

/**
 * Splits a frame into Bluetooth chunks.
 * @category Transport
 * @internal
 */
export function toBluetoothChunks(frame: Uint8Array): Uint8Array[] {
    const total = Math.ceil(frame.length / BLUETOOTH_CHUNK_DATA_SIZE)
    if (total > BLUETOOTH_CHUNK_MAX_CHUNKS)
        throw new Error(`frame too large for Bluetooth (${frame.length} bytes)`)
    const chunks: Uint8Array[] = []
    for (let i = 0; i < total; ++i) {
        const data = frame.subarray(
            i * BLUETOOTH_CHUNK_DATA_SIZE,
            (i + 1) * BLUETOOTH_CHUNK_DATA_SIZE
        )
        const chunk = new Uint8Array(BLUETOOTH_CHUNK_HEADER_SIZE + data.length)
        chunk[0] = total | (i == 0 ? BLUETOOTH_CHUNK_FIRST_FLAG : 0)
        chunk[1] = total - 1 - i
        chunk.set(data, BLUETOOTH_CHUNK_HEADER_SIZE)
        chunks.push(chunk)
    }
    return chunks
}

/**
 * Reassembles frames from Bluetooth chunks. Incomplete or out-of-order frames are dropped,
 * never delivered; chunks that do not belong to a frame are ignored until the next first chunk.
 * @category Transport
 * @internal
 */
export class BluetoothChunkReassembler {
    private buffer: Uint8Array
    private length = 0
    // value of byte 1 expected in the next chunk
    private expectedRemaining = 0

    /** Frames dropped because chunks were missing, out of order or malformed */
    droppedFrames = 0
    /** Chunks ignored because no frame was in progress */
    strayChunks = 0

    /**
     * Adds a chunk; returns the frame when this chunk completes one, otherwise undefined.
     */
    push(chunk: Uint8Array): Uint8Array | undefined {
        if (!chunk || chunk.length < BLUETOOTH_CHUNK_HEADER_SIZE) {
            this.drop()
            return undefined
        }

        const first = !!(chunk[0] & BLUETOOTH_CHUNK_FIRST_FLAG)
        const total = chunk[0] & BLUETOOTH_CHUNK_MAX_CHUNKS
        const remaining = chunk[1]
        const data = chunk.subarray(BLUETOOTH_CHUNK_HEADER_SIZE)

        if (first) {
            // a new frame starts; anything in progress is lost
            this.drop()
            if (total == 0 || remaining != total - 1) {
                this.droppedFrames++
                return undefined
            }
            this.buffer = new Uint8Array(total * BLUETOOTH_CHUNK_DATA_SIZE)
            this.length = 0
        } else if (!this.buffer) {
            this.strayChunks++
            return undefined
        } else if (remaining != this.expectedRemaining) {
            this.drop()
            return undefined
        }

        if (this.length + data.length > this.buffer.length) {
            this.drop()
            return undefined
        }
        this.buffer.set(data, this.length)
        this.length += data.length

        if (remaining == 0) {
            const frame = this.buffer.slice(0, this.length)
            this.reset()
            return frame
        }
        this.expectedRemaining = remaining - 1
        return undefined
    }

    /** Forgets any frame in progress without counting it as dropped */
    reset() {
        this.buffer = undefined
        this.length = 0
        this.expectedRemaining = 0
    }

    private drop() {
        if (this.buffer) this.droppedFrames++
        this.reset()
    }
}
