import {
    CursorCharacterScreenCmd,
    CursorCharacterScreenReg,
    SRV_CURSOR_CHARACTER_SCREEN,
} from "../jdom/constants"
import { Packet } from "../jdom/packet"
import { JDRegisterServer } from "../jdom/servers/registerserver"
import { JDServiceServer } from "../jdom/servers/serviceserver"

export class CursorCharacterScreenServer extends JDServiceServer {
    static readonly UPDATE = "ccss_update"
    readonly enabled: JDRegisterServer<[number]>
    readonly rows: JDRegisterServer<[number]>
    readonly columns: JDRegisterServer<[number]>
    private _cursorX = 0
    private _cursorY = 0
    private _screen: Array<Array<string>>

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

        // create a 2d array to hold the characters
        this._screen = Array.from({ length: rows }, () =>
            Array(columns).fill(" "),
        )

        this.rows = this.addRegister<[number]>(CursorCharacterScreenReg.Rows, [
            rows,
        ])
        this.columns = this.addRegister<[number]>(
            CursorCharacterScreenReg.Columns,
            [columns],
        )
        this.enabled = this.addRegister<[number]>(
            CursorCharacterScreenReg.Enabled,
            [enabled],
        )
        this.addCommand(CursorCharacterScreenCmd.Home, this.home.bind(this))
        this.addCommand(CursorCharacterScreenCmd.Clear, this.clear.bind(this))
        this.addCommand(
            CursorCharacterScreenCmd.SetCursor,
            this.setCursor.bind(this),
        )
        this.addCommand(
            CursorCharacterScreenCmd.Show,
            this.show.bind(this),
        )

        this.clear() // clear the screen initially
        if (message) this._show(message)
    }
  
    public get screen(): string {
        return this._screen.map(row => row.join("")).join("\n")
    }

    private _show(text: string) {
        // split the text by newline
        const lines = text.split("\n")
        
        // now start filling from the cursor
        // but don't move the cursor
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i]
            if (this._cursorY + i >= this._screen.length) break // no more rows
            const row = this._screen[this._cursorY + i]
            const startCol = i === 0 ? this._cursorX : 0
            for (let j = 0; j < line.length; j++) {
                if (startCol + j >= row.length) break // no more columns
                row[startCol + j] = line[j]
            }
        }
        this.emit(CursorCharacterScreenServer.UPDATE)
    }

    private show(pkt: Packet) {
        const [text] = pkt.jdunpack<[string]>("s")
        this._show(text)
    }

    private home() {
        this._setCursor(0, 0)
    }

    private clear() {
        this._setCursor(0, 0)
        // clear the screen
        this._screen.forEach(row => row.fill(" "))
        this.emit(CursorCharacterScreenServer.UPDATE)
    }

    private setCursor(pkt: Packet) {
        const [x, y] = pkt.jdunpack<[number, number]>("u8 u8")
        this._setCursor(x, y)
    }

    private _setCursor(x: number, y: number): void {
        const [rows] = this.rows.values()
        const [columns] = this.columns.values()
        if (columns > 0 && x >= columns) x = columns - 1
        if (rows > 0 && y >= rows) y = rows - 1
        this._cursorX = x
        this._cursorY = y
    }
}
