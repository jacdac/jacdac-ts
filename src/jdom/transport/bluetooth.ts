import { Flags } from "../flags"
import { delay } from "../utils"
import {
    BLUETOOTH_JACDAC_TX_CHARACTERISTIC,
    BLUETOOTH_JACDAC_RX_CHARACTERISTIC,
    BLUETOOTH_JACDAC_SERVICE,
    BLUETOOTH_TRANSPORT,
} from "../constants"
import { Transport } from "./transport"
import { BluetoothChunkReassembler, toBluetoothChunks } from "./bluetoothchunks"

/**
 * Advertised name prefixes of devices that may expose the Jacdac Bluetooth service
 */
const BLE_DEVICE_NAME_PREFIXES = ["BBC micro:bit", "Calliope mini"]
// frames waiting to be written; newer frames are dropped beyond this
const BLE_MAX_PENDING_FRAMES = 32
// retries of a write that failed because another GATT operation was in progress
const BLE_WRITE_RETRIES = 5
// announces arrive every 500ms but may be delayed or dropped by the device's
// small transmit queue; reconnecting over Bluetooth is slow, so be more tolerant than 1s
const BLE_PULSE_TIMEOUT = 3000

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface WebBluetoothOptions {}

/**
 * Indicates with Web Bluetooth transport are enabled
 * @category Transport
 */
export function isWebBluetoothEnabled(): boolean {
    return !!Flags.webBluetooth
}

/**
 * Indicates with Web Bluetooth is supported in this environment
 * @category Transport
 */
export function isWebBluetoothSupported(): boolean {
    try {
        return (
            typeof navigator !== "undefined" &&
            !!navigator.bluetooth &&
            !!navigator.bluetooth.requestDevice
        )
    } catch (e) {
        return false
    }
}

function bleRequestDevice(
    options?: RequestDeviceOptions
): Promise<BluetoothDevice> {
    // disabled
    if (!Flags.webBluetooth) return Promise.resolve(undefined)

    try {
        console.debug(`bluetooth request`, { options })
        return navigator?.bluetooth?.requestDevice?.(options)
    } catch (e) {
        if (Flags.diagnostics) console.warn(e)
        return undefined
    }
}

function bleGetDevices(): Promise<BluetoothDevice[]> {
    // disabled
    if (!Flags.webBluetooth) return Promise.resolve([])

    try {
        return navigator?.bluetooth?.getDevices() || Promise.resolve([])
    } catch (e) {
        if (Flags.diagnostics) console.warn(e)
        return Promise.resolve([])
    }
}

class BluetoothTransport extends Transport {
    private _device: BluetoothDevice
    // last device connected, reused for background reconnects
    private _lastDevice: BluetoothDevice
    private _server: BluetoothRemoteGATTServer
    private _service: BluetoothRemoteGATTService
    private _rxCharacteristic: BluetoothRemoteGATTCharacteristic
    private _txCharacteristic: BluetoothRemoteGATTCharacteristic
    private readonly _reassembler = new BluetoothChunkReassembler()
    // serializes writes: chunks of different frames must never interleave
    private _writeQueue: Promise<void> = Promise.resolve()
    private _pendingFrames = 0

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(options?: WebBluetoothOptions) {
        super(BLUETOOTH_TRANSPORT, { checkPulse: true })

        this.handleDisconnected = this.handleDisconnected.bind(this)
        this.handleCharacteristicChanged =
            this.handleCharacteristicChanged.bind(this)
    }

    description(): string {
        return this._device?.name
    }

    protected get pulseTimeout() {
        return BLE_PULSE_TIMEOUT
    }

    protected async transportConnectAsync(background: boolean) {
        // get a device
        if (background) {
            const devices = await bleGetDevices()
            const last = this._lastDevice
            this._device =
                (last && devices?.find(d => d.id === last.id)) ||
                last ||
                devices?.[0]
        } else {
            const device = await bleRequestDevice({
                filters: BLE_DEVICE_NAME_PREFIXES.map(namePrefix => ({
                    namePrefix,
                })),
                optionalServices: [BLUETOOTH_JACDAC_SERVICE],
            })
            this._device = device
        }

        if (!this._device?.gatt) throw new Error("Device not found")
        this._lastDevice = this._device

        // listen for disconnection
        this._device.addEventListener(
            "gattserverdisconnected",
            this.handleDisconnected,
            false
        )

        this._reassembler.reset()

        // connect to gatt
        this._server = await this._device.gatt.connect()
        // connect to service
        this._service = await this._server.getPrimaryService(
            BLUETOOTH_JACDAC_SERVICE
        )
        // device to PC
        this._rxCharacteristic = await this._service.getCharacteristic(
            BLUETOOTH_JACDAC_RX_CHARACTERISTIC
        )
        // PC to device
        this._txCharacteristic = await this._service.getCharacteristic(
            BLUETOOTH_JACDAC_TX_CHARACTERISTIC
        )
        // listen for incoming packet
        this._rxCharacteristic.addEventListener(
            "characteristicvaluechanged",
            this.handleCharacteristicChanged,
            false
        )
        // start listening (works for notifications and indications)
        await this._rxCharacteristic.startNotifications()
    }

    protected transportSendPacketAsync(data: Uint8Array): Promise<void> {
        if (!this._txCharacteristic) {
            console.debug(`trying to send Bluetooth packet while disconnected`)
            return Promise.resolve()
        }
        if (this._pendingFrames >= BLE_MAX_PENDING_FRAMES) {
            if (Flags.diagnostics)
                console.debug(`ble: write queue full, frame dropped`)
            return Promise.resolve()
        }

        let chunks: Uint8Array[]
        try {
            chunks = toBluetoothChunks(data)
        } catch (e) {
            console.warn(e)
            return Promise.resolve()
        }

        this._pendingFrames++
        const write = this._writeQueue
            .then(() => this.writeChunksAsync(chunks))
            .catch(e => {
                // drop the rest of this frame; a lost link is handled by
                // the disconnect event and the pulse check
                if (Flags.diagnostics) console.debug(`ble: write failed`, e)
            })
            .finally(() => this._pendingFrames--)
        this._writeQueue = write
        return write
    }

    private async writeChunksAsync(chunks: Uint8Array[]) {
        const characteristic = this._txCharacteristic
        for (const chunk of chunks) {
            // stop if disconnected or reconnected meanwhile: never send the
            // rest of a frame over a new connection
            if (!characteristic || characteristic !== this._txCharacteristic)
                return
            await this.writeChunkAsync(characteristic, chunk)
        }
    }

    private async writeChunkAsync(
        characteristic: BluetoothRemoteGATTCharacteristic,
        chunk: Uint8Array
    ) {
        for (let attempt = 0; ; attempt++) {
            try {
                if (characteristic.writeValueWithoutResponse)
                    await characteristic.writeValueWithoutResponse(chunk)
                else await characteristic.writeValue(chunk)
                return
            } catch (e) {
                const busy = /in progress/i.test(e?.message || "")
                if (!busy || attempt >= BLE_WRITE_RETRIES) throw e
                await delay(5 * (attempt + 1))
            }
        }
    }

    protected async transportDisconnectAsync() {
        if (!this._device) return

        console.debug(`ble: disconnecting`)
        try {
            this._rxCharacteristic?.removeEventListener(
                "characteristicvaluechanged",
                this.handleCharacteristicChanged
            )
            this._device?.removeEventListener(
                "gattserverdisconnected",
                this.handleDisconnected
            )
            this._server?.disconnect()
        } finally {
            this._rxCharacteristic = undefined
            this._txCharacteristic = undefined
            this._service = undefined
            this._server = undefined
            this._device = undefined
            this._reassembler.reset()
        }
    }

    private handleDisconnected() {
        // start disconnecting
        this.disconnect()
    }

    private handleCharacteristicChanged(ev: Event) {
        const value = (ev?.target as BluetoothRemoteGATTCharacteristic)?.value
        if (!value) return
        const chunk = new Uint8Array(
            value.buffer,
            value.byteOffset,
            value.byteLength
        )
        const { droppedFrames } = this._reassembler
        const frame = this._reassembler.push(chunk)
        if (
            Flags.diagnostics &&
            this._reassembler.droppedFrames !== droppedFrames
        )
            console.debug(
                `ble: incomplete frame dropped (${this._reassembler.droppedFrames} total)`
            )
        // handleFrame also records the receive time used by the pulse check
        if (frame) this.handleFrame(frame)
    }
}

/**
 * Creates a transport that uses Web Bluetooth
 * @category Transport
 */
export function createBluetoothTransport(
    options?: WebBluetoothOptions
): Transport {
    return isWebBluetoothSupported() && new BluetoothTransport(options)
}
