import { jdpack, jdunpack } from "../jdom/pack"
import { Packet } from "../jdom/packet"
import { JDRegisterServer } from "../jdom/servers/registerserver"
import { JDServiceServer, JDServerOptions } from "../jdom/servers/serviceserver"

export interface BitmapServerOptions extends JDServerOptions {
    width?: number
    height?: number
}

/**
 * Server implementation for the bitmap service
 * @category Servers
 */
export class BitmapServer extends JDServiceServer {
    readonly width: JDRegisterServer<[number]>
    readonly height: JDRegisterServer<[number]>

    private _pixels: ImageData

    constructor(options?: BitmapServerOptions) {
        super(SRV_BITMAP, options)

        const { width = 160, height = 120 } = options || {}

        this.width = this.addRegister(BitmapReg.Width, [width])
        this.height = this.addRegister(BitmapReg.Height, [height])
        this.addCommand(BitmapCmd.Fill, this.handleFill.bind(this))
    }

    handleFill(pkt: Packet) {}
}
