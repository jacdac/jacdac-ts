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

        const {
            width = 160,
            height = 120,
            palette = [
                0x000000, 0xffffff, 0xff2121, 0xff93c4, 0xff8135, 0xfff609,
                0x249ca3, 0x78dc52, 0x003fad, 0x87f2ff, 0x8e2ec4, 0xa4839f,
                0x5c406c, 0xe5cdc4, 0x91463d, 0x000000,
            ],
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
