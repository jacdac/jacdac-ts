import { BitmapCmd, BitmapReg, CHANGE, SRV_BITMAP } from "../jdom/constants"
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
    private _canvas: HTMLCanvasElement
    private _context: CanvasRenderingContext2D 

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
        const canvas = document.createElement("canvas");
        this._canvas = canvas
        this._canvas.width = width
        this._canvas.height = height
        this._context = this._canvas.getContext("2d");

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

    get canvas() {
        return this._canvas
    }
    
    private getRgb(color_index: number) {
        const index = color_index << 2
        const r = this._palette[index]
        const g = this._palette[index+1]
        const b = this._palette[index+2]
        return `rgb(${r},${g},${b})`
    }

    handleFill(pkt: Packet) {
        const [color_index] = jdunpack<[number]>(
            pkt.data,
            "u8",
        )
        if (color_index < this._palette.length >> 2) {
            this._context.fillStyle = this.getRgb(color_index)
            this._context.fillRect(0, 0, this.canvas.width, this.canvas.height);
            this.emit(CHANGE)
        }
    }
}
