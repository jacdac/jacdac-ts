import { jdpack, jdunpack } from "../jdom/pack"
import { Packet } from "../jdom/packet"
import { JDRegisterServer } from "../jdom/servers/registerserver"
import { JDServiceServer, JDServerOptions } from "../jdom/servers/serviceserver"

export interface BitmapServerOptions extends JDServerOptions {
    width?: number
    height?: number
    // 24bit rgb colors
    palette?: number[]
}

/**
 * Server implementation for the bitmap service
 * @category Servers
 */
export class BitmapServer extends JDServiceServer {
    readonly width: JDRegisterServer<[number]>
    readonly height: JDRegisterServer<[number]>

    private _palette: Uint8Array
    private _pixels: ImageData

    constructor(options?: BitmapServerOptions) {
        super(SRV_BITMAP, options)

        const { width = 160, 
                height = 120, 
                palette = [0xff0000, 0xffffff],
            } = options || {}

        this.width = this.addRegister(BitmapReg.Width, [width])
        this.height = this.addRegister(BitmapReg.Height, [height])
        
        const pbuf = new Uint8Array(palette.length << 2)
        for (let i = 0; i < palette.length; ++i) {
            pbuf[i * 4] = (palette[i] >> 16) & 0xff
            pbuf[i * 4 + 1] = (palette[i] >> 8) & 0xff
            pbuf[i * 4 + 2] = palette[i] & 0xff
            pbuf[i * 4 + 3] = 0xff
        }
        this._palette = pbuf

        this.addCommand(BitmapCmd.Fill, this.handleFill.bind(this))
    }

    handleFill(pkt: Packet) {
        // get the color index
    }
}
