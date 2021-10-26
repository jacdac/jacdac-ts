import JDBus, { BusOptions } from "../bus"
import { createUSBTransport, isWebUSBSupported } from "./usb"
import { createWebSerialTransport, isWebSerialSupported } from "./webserial"
import { createBluetoothTransport, isWebBluetoothSupported } from "./bluetooth"
import { USBOptions } from "./usbio"
import createIFrameBridge from "../bridges/iframebridge"

/**
 * Options to instantiate a bus. By default, the bus acts as a client.
 */
export interface WebBusOptions extends BusOptions {
    /**
     * USB connection options
     */
    usbOptions?: USBOptions
    iframeTargetOrigin?: string
    /**
     * Bus self device advertises itself as a client
     */
    client?: boolean
}

/**
 * Creates a Jacdac bus using WebUSB, WebSerial or WebBluetooth
 * @param options
 * @returns
 * @category Transport
 */
export function createWebBus(options?: WebBusOptions) {
    const {
        usbOptions,
        iframeTargetOrigin,
        client = true,
        ...rest
    } = options || {}
    const bus = new JDBus(
        [
            usbOptions !== null && createUSBTransport(usbOptions),
            createWebSerialTransport(),
            createBluetoothTransport(),
        ],
        { client, ...rest }
    )
    const iframeBridge =
        iframeTargetOrigin !== null && createIFrameBridge(iframeTargetOrigin)
    if (iframeBridge) iframeBridge.bus = bus
    return bus
}

/**
 * Indicates if any of the USB/Serial/Bluetooth transports is supported
 * @returns
 * @category Transport
 */
export function isWebTransportSupported() {
    return (
        isWebUSBSupported() ||
        isWebSerialSupported() ||
        isWebBluetoothSupported()
    )
}
