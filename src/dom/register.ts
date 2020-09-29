import { Packet } from "./packet";
import { CMD_SET_REG, REPORT_RECEIVE, REPORT_UPDATE, CHANGE, CMD_GET_REG, REGISTER_NODE_NAME } from "./constants";
import { JDService } from "./service";
import { intOfBuffer } from "./buffer";
import { JDNode } from "./node";
import { bufferEq, toHex, fromUTF8, uint8ArrayToString, toUTF8, stringToUint8Array, delay, withTimeout } from "./utils";
import { bufferOfInt } from "./struct";
import { decodePacketData, DecodedPacket } from "./pretty";
import { isRegister, isReading } from "./spec";
import { JDField } from "./field";
import { JDServiceMemberNode } from "./servicemembernode";


export class JDRegister extends JDServiceMemberNode {
    private _lastReportPkt: Packet;
    private _fields: JDField[];

    constructor(
        service: JDService,
        address: number) {
        super(service, address, isRegister)
    }

    get nodeKind() {
        return REGISTER_NODE_NAME
    }

    get fields() {
        if (!this._fields)
            this._fields = this.specification?.fields.map((field, index) => new JDField(this, index, field));
        return this._fields;
    }

    // send a message to set the register value
    sendSetAsync(data: Uint8Array, autoRefresh?: boolean): Promise<void> {
        const cmd = CMD_SET_REG | this.address;
        const pkt = Packet.from(cmd, data)
        let p = this.service.sendPacketAsync(pkt, this.service.registersUseAcks)
        if (autoRefresh)
            p = delay(50).then(() => this.sendGetAsync())
        return p;
    }

    sendGetAsync(): Promise<void> {
        if (this.specification?.kind === "const" &&
            this.data !== undefined)
            return Promise.resolve();

        const cmd = CMD_GET_REG | this.address;
        return this.service.sendCmdAsync(cmd)
    }

    sendSetIntAsync(value: number, autoRefresh?: boolean): Promise<void> {
        return this.sendSetAsync(bufferOfInt(value), autoRefresh)
    }

    sendSetBoolAsync(value: boolean, autoRefresh?: boolean): Promise<void> {
        return this.sendSetIntAsync(value ? 1 : 0, autoRefresh)
    }

    sendSetStringAsync(value: string, autoRefresh?: boolean): Promise<void> {
        return this.sendSetAsync(stringToUint8Array(toUTF8(value || "")), autoRefresh)
    }

    get isReading() {
        return this.specification && isReading(this.specification)
    }

    get data() {
        return this._lastReportPkt?.data;
    }

    get lastDataTimestamp() {
        return this._lastReportPkt?.timestamp
    }

    get intValue(): number {
        const d = this.data;
        return d && intOfBuffer(d);
    }

    get boolValue(): boolean {
        if (this.data === undefined) return undefined;
        return !!this.intValue;
    }

    get stringValue(): string {
        const buf = this.data;
        if (buf === undefined) return undefined;

        let value: string;
        try {
            value = fromUTF8(uint8ArrayToString(buf))
        } catch {
            // invalid UTF8
            value = uint8ArrayToString(buf)
        }
        return value;
    }

    get humanValue(): string {
        return this.decoded?.decoded?.map(field => field.humanValue).join(',');
    }

    toString() {
        const d = this.data;
        return `${this.id} ${d ? toHex(d) : ""}`
    }

    get decoded(): DecodedPacket {
        return this._lastReportPkt?.decoded;
    }

    refresh(skipIfValue?: boolean): Promise<void> {
        // don't refetch if already data
        if (skipIfValue && !!this.data)
            return;

        // don't refetch consts
        if (!!this.data && this.specification?.kind === "const")
            return;

        return withTimeout(150, new Promise<void>((resolve, reject) => {
            this.once(REPORT_RECEIVE, () => {
                const f = resolve
                resolve = null
                f()
            })
            // re-send get if no answer within 20ms and 70ms
            this.sendGetAsync()
                .then(() => delay(20))
                .then(() => {
                    if (resolve)
                        return this.sendGetAsync()
                            .then(() => delay(50))
                })
                .then(() => {
                    if (resolve)
                        return this.sendGetAsync()
                })
                .then(() => { }, reject)
        }))
    }

    processReport(pkt: Packet) {
        const updated = !bufferEq(this.data, pkt.data)
        this._lastReportPkt = pkt;
        this.emit(REPORT_RECEIVE, this)
        if (updated) {
            this.emit(REPORT_UPDATE, this)
            this.emit(CHANGE)
        }
    }

    compareTo(b: JDRegister) {
        const a = this;
        return a.address - b.address ||
            a.service.compareTo(b.service);
    }
}

export function stableSortRegisters(registers: JDRegister[]): JDRegister[] {
    return registers?.sort((a, b) => a.compareTo(b))
}