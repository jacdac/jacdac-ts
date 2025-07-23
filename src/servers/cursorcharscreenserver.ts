import {
    CursorCharacterScreenCmd,
    CursorCharacterScreenReg,
    SRV_CURSOR_CHARACTER_SCREEN,
} from "../jdom/constants"
import { Packet } from "../jdom/packet"
import { JDRegisterServer } from "../jdom/servers/registerserver"
import { JDServiceServer } from "../jdom/servers/serviceserver"

export class CursorCharacterScreenServer extends JDServiceServer {
    readonly message: JDRegisterServer<[string]>
    readonly enabled: JDRegisterServer<[number]>
    readonly rows: JDRegisterServer<[number]>
    readonly columns: JDRegisterServer<[number]>
    private _cursorX = 0
    private _cursorY = 0

    constructor(options?: {
        message?: string
        rows?: number
        columns?: number
        enabled?: number
    }) {
        super(SRV_CURSOR_CHARACTER_SCREEN)
        const {
            message = "",
            rows = 2,
            columns = 16,
            enabled = 100,
        } = options || {}

        this.message = this.addRegister<[string]>(CursorCharacterScreenReg.Message, [
            message,
        ])
        this.rows = this.addRegister<[number]>(CursorCharacterScreenReg.Rows, [rows])
        this.columns = this.addRegister<[number]>(CursorCharacterScreenReg.Columns, [
            columns,
        ])
        this.enabled = this.addRegister<[number]>(
            CursorCharacterScreenReg.Enabled,
            [enabled,]
        )
        this.message = this.addRegister<[string]>(CursorCharacterScreenReg.Message, [
            "",
        ])
        this.addCommand(CursorCharacterScreenCmd.Home, this.home.bind(this))
        this.addCommand(CursorCharacterScreenCmd.Clear, this.clear.bind(this))
        this.addCommand(CursorCharacterScreenCmd.SetCursor, this.setCursor.bind(this))

        this._setCursor(0, 0)
    }

    private home() {
        this._setCursor(0, 0)
    }

    private clear() {
        this.message.setValues([""])
        this._setCursor(0, 0)
    }

    private setCursor(pkt: Packet) {
        const [x, y] = pkt.jdunpack<[number, number]>("u8 u8")
        this._setCursor(x, y)
    }

    private _setCursor(x: number, y: number): void {
        const [rows] = this.rows.values()
        const [columns] = this.columns.values()
        if (x < 0 || x >= columns || y < 0 || y >= rows) {
            return
        }
        this._cursorX = x
        this._cursorY = y
    }
    get cursorX(): number {
        return this._cursorX
    }
    get cursorY(): number {
        return this._cursorY
    }
}
