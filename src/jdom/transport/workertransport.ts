import { USB_TRANSPORT } from "../constants"
import { EventTargetObservable } from "../eventtargetobservable"
import Packet from "../packet"
import { JDTransport, JDTransportOptions } from "./transport"
import {
    TransportConnectMessage,
    TransportMessage,
    TransportPacketMessage,
} from "./transportmessages"
import { isWebUSBEnabled, usbRequestDevice } from "./usb"
import { USB_FILTERS } from "./usbio"

class WorkerTransport extends JDTransport {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private pending: {
        [id: string]: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            resolve: (t: any) => void
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            reject: (e: any) => void
        }
    } = {}

    constructor(
        public readonly type: string,
        public readonly worker: Worker,
        public readonly options: {
            requestDevice: () => Promise<void>
        } & JDTransportOptions
    ) {
        super(type, options)
        this.worker.onmessage = this.handleMessage.bind(this)
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private postMessageAsync<T>(msg: TransportMessage) {
        const id = (msg.id = "" + Math.random())
        const p = new Promise<T>((resolve, reject) => {
            this.worker.postMessage(msg)
            this.pending[id] = { resolve, reject }
        })
        return p
    }

    private handleMessage(ev: MessageEvent) {
        const data: TransportMessage = ev.data
        const { type } = data || {}
        switch (type) {
            case "packet": {
                const { payload } = data as TransportPacketMessage
                //debug(`wt: packet`, payload)
                this.handlePacket(payload)
                break
            }
            case "frame": {
                const { payload } = data as TransportPacketMessage
                //debug(`wt: frame`, payload)
                this.handleFrame(payload)
                break
            }
            case "connect":
            case "disconnect": {
                const { id, error } = data
                const { resolve, reject } = this.pending[id] || {}
                if (resolve) {
                    if (error) reject(error)
                    else resolve(undefined)
                }
                break
            }
        }
    }

    protected async transportSendPacketAsync(p: Packet): Promise<void> {
        // don't wait
        const buf = p.toBuffer()
        this.worker.postMessage({
            type: "packet",
            payload: buf,
        } as TransportPacketMessage)
    }

    protected async transportConnectAsync(background?: boolean) {
        if (!background) {
            // request permission first
            await this.options.requestDevice()
        }

        // try connect
        await this.postMessageAsync<void>({
            type: "connect",
            background,
        } as TransportConnectMessage)
    }

    protected transportDisconnectAsync(): Promise<void> {
        return this.postMessageAsync<void>({
            type: "disconnect",
        })
    }
}

export function createUSBWorkerTransport(worker: Worker) {
    return (
        isWebUSBEnabled() &&
        new WorkerTransport(USB_TRANSPORT, worker, {
            requestDevice: () => usbRequestDevice(USB_FILTERS).then(() => {}),
            connectObservable: new EventTargetObservable(
                navigator.usb,
                "connect"
            ),
            disconnectObservable: new EventTargetObservable(
                navigator.usb,
                "disconnect"
            ),
        })
    )
}
