import { jdunpack } from "../jdom/pack"
import {
    fromUTF8,
    range,
    read16,
    read32,
    stringToUint8Array,
    toUTF8,
    uint8ArrayToString,
    write16,
    write32,
} from "../jdom/utils"
import {
    assertPos,
    BinSection,
    FunctionInfo,
    hex,
    loadImage,
    oopsPos,
} from "./executor"
import {
    BinFmt,
    bitSize,
    CellDebugInfo,
    CellKind,
    DebugInfo,
    emptyDebugInfo,
    FunctionDebugInfo,
    InstrArgResolver,
    isPrefixInstr,
    NUM_REGS,
    OpAsync,
    OpBinary,
    OpFmt,
    OpSync,
    OpTop,
    OpUnary,
    SMap,
    stringifyCellKind,
    stringifyInstr,
    ValueSpecial,
} from "./format"

class Resolver implements InstrArgResolver {
    constructor(private floats: Float64Array, private dbg: DebugInfo) {}
    resolverParams: number[]
    describeCell(t: CellKind, idx: number): string {
        switch (t) {
            case CellKind.GLOBAL:
                return this.dbg.globals[idx]?.name
            case CellKind.FLOAT_CONST:
                return this.floats[idx] + ""
            default:
                return undefined
        }
    }
    funName(idx: number): string {
        return this.dbg.functions[idx]?.name
    }
    roleName(idx: number): string {
        return this.dbg.roles[idx]?.name
    }
}

export function numSetBits(n: number) {
    let r = 0
    for (let i = 0; i < 32; ++i) if (n & (1 << i)) r++
    return r
}

export function verifyBinary(bin: Uint8Array, dbg = emptyDebugInfo()) {
    const sourceLines = dbg.source.split(/\n/)

    const {
        funDesc,
        funData,
        floatData,
        roleData,
        strDesc,
        strData,
        sects,
        numGlobals,
    } = loadImage(bin)

    for (let i = 0; i < sects.length; ++i) {
        console.log(`sect ${sects[i]}`)
        if (i > 0)
            assertPos(
                sects[i].offset,
                sects[i - 1].end == sects[i].start,
                "section in order"
            )
    }

    assertPos(
        floatData.offset,
        (floatData.length & 7) == 0,
        "float data 8-aligned"
    )
    const floats = new Float64Array(floatData.asBuffer())

    const resolver = new Resolver(floats, dbg)
    const numFuncs = funDesc.length / BinFmt.FunctionHeaderSize
    const numRoles = roleData.length / BinFmt.RoleHeaderSize
    const numStrings = strDesc.length / BinFmt.SectionHeaderSize

    let prevProc = funData.start
    let idx = 0
    for (
        let ptr = funDesc.start;
        ptr < funDesc.end;
        ptr += BinFmt.FunctionHeaderSize
    ) {
        const funSect = new BinSection(bin, ptr)
        assertPos(ptr, funSect.start == prevProc, "func in order")
        funData.mustContain(ptr, funSect)
        prevProc = funSect.end
        verifyFunction(ptr, funSect, dbg.functions[idx])
        idx++
    }

    idx = 0
    for (
        let ptr = strDesc.start;
        ptr < strDesc.end;
        ptr += BinFmt.SectionHeaderSize
    ) {
        const strSect = new BinSection(bin, ptr)
        strData.mustContain(ptr, strSect)
        const str = fromUTF8(
            uint8ArrayToString(new Uint8Array(strSect.asBuffer()))
        )
        console.log(`str #${idx} = ${JSON.stringify(str)}`)
        idx++
    }

    idx = 0
    for (
        let ptr = roleData.start;
        ptr < roleData.end;
        ptr += BinFmt.RoleHeaderSize
    ) {
        const cl = read32(bin, ptr)
        const top = cl >>> 28
        assertPos(
            ptr,
            top == 0x1 || top == 0x2,
            "service class starts with 0x1 or 0x2 (mixin)"
        )
        console.log(`role #${idx} = ${hex(cl)} ${dbg.roles[idx]?.name || ""}`)
        idx++
    }

    for (let i = 0; i < floats.length; ++i)
        console.log(`float #${i} = ${floats[i]}`)

    function verifyFunction(hd: number, f: BinSection, dbg: FunctionDebugInfo) {
        assertPos(hd, f.length > 0, "func size > 0")
        const funcode = new Uint16Array(f.asBuffer())
        console.log(`fun ${f} ${dbg?.name}`)
        const srcmap = dbg?.srcmap || []
        let srcmapPtr = 0
        let prevLine = -1
        let params = [0, 0, 0, 0]
        let [a, b, c, d] = params
        let writtenRegs = 0
        let pc = 0
        let isJumpTarget: boolean[] = []

        const info = new FunctionInfo(bin, hd, dbg)

        for (let pass = 0; pass < 2; ++pass) {
            for (; pc < funcode.length; ++pc) {
                while (pc >= srcmap[srcmapPtr + 1] + srcmap[srcmapPtr + 2])
                    srcmapPtr += 3
                if (prevLine != srcmap[srcmapPtr]) {
                    prevLine = srcmap[srcmapPtr]
                    if (prevLine)
                        console.log(
                            `; (${prevLine}): ${
                                sourceLines[prevLine - 1] || ""
                            }`
                        )
                }
                const instr = funcode[pc]
                const pref = isPrefixInstr(instr) ? "    " : "             "
                console.log(pref + stringifyInstr(instr, resolver))

                if (isJumpTarget[pc]) writtenRegs = 0

                verifyInstr(instr)
            }
        }

        function verifyInstr(instr: number) {
            const op = instr >> 12
            const arg12 = instr & 0xfff
            const arg10 = instr & 0x3ff
            const arg8 = instr & 0xff
            const arg6 = instr & 0x3f
            const arg4 = instr & 0xf
            const subop = arg12 >> 8

            const reg0 = subop
            const reg1 = arg8 >> 4
            const reg2 = arg4
            let lastOK = false

            ;[a, b, c, d] = params

            switch (op) {
                case OpTop.LOAD_CELL:
                case OpTop.STORE_CELL:
                case OpTop.JUMP:
                case OpTop.CALL:
                    b = (b << 6) | arg6
                    break
            }

            switch (op) {
                case OpTop.LOAD_CELL:
                case OpTop.STORE_CELL:
                    a = (a << 2) | (arg8 >> 6)
                    break
            }

            switch (op) {
                case OpTop.SET_A:
                case OpTop.SET_B:
                case OpTop.SET_C:
                case OpTop.SET_D:
                    params[op] = arg12
                    break

                case OpTop.SET_HIGH:
                    check(arg10 >> 4 == 0, "set_high only supported for 16 bit")
                    params[arg12 >> 10] |= arg10 << 12
                    break

                case OpTop.UNARY: // OP[4] DST[4] SRC[4]
                    rdReg(reg2)
                    wrReg(reg1)
                    check(subop < OpUnary._LAST, "valid uncode")
                    break

                case OpTop.BINARY: // OP[4] DST[4] SRC[4]
                    rdReg(reg1)
                    rdReg(reg2)
                    wrReg(reg1)
                    check(subop < OpBinary._LAST, "valid bincode")
                    break

                case OpTop.LOAD_CELL: // DST[4] A:OP[2] B:OFF[6]
                    wrReg(reg0)
                    verifyCell(a, b, false)
                    break

                case OpTop.STORE_CELL: // SRC[4] A:OP[2] B:OFF[6]
                    rdReg(reg0)
                    verifyCell(a, b, true)
                    break

                case OpTop.JUMP: // REG[4] BACK[1] IF_ZERO[1] B:OFF[6]
                    let pc2 = pc + 1
                    if (arg8 & (1 << 7)) {
                        pc2 -= b
                    } else {
                        pc2 += b
                    }
                    check(pc2 >= 0, "jump before")
                    check(pc2 < funcode.length, "jump after")
                    check(
                        pc2 == 0 || !isPrefixInstr(funcode[pc2 - 1]),
                        "jump into prefix"
                    )
                    isJumpTarget[pc2] = true
                    if (arg8 & (1 << 6)) rdReg(reg0)
                    else lastOK = true
                    break

                case OpTop.CALL: // NUMREGS[4] BG[1] 0[1] B:OFF[6]
                    rdRegs(subop)
                    if (arg8 << (1 << 7)) {
                        // bg
                    }
                    check(b < numFuncs, "call fn in range")
                    break

                case OpTop.SYNC: // A:ARG[4] OP[8]
                    a = (a << 4) | subop
                    switch (arg8) {
                        case OpSync.RETURN:
                            lastOK = true
                            break
                        case OpSync.SETUP_BUFFER: // A-size
                            check(a <= 236, "setup buffer size in range")
                            break
                        case OpSync.OBSERVE_ROLE: // A-role
                            check(a < numRoles, "role in range")
                            break
                        case OpSync.FORMAT: // A-string-index B-numargs
                            rdRegs(b)
                            check(a < numStrings, "str in range")
                            break
                        case OpSync.MEMCPY: // A-string-index
                            check(a < numStrings, "str in range")
                            break
                        default:
                            check(false, "invalid sync code")
                            break
                    }
                    break

                case OpTop.ASYNC: // D:SAVE_REGS[4] OP[8]
                    d = (d << 4) | subop
                    for (let i = 0; i < NUM_REGS; i++)
                        if (d & (1 << i)) rdReg(i)
                    check(
                        numSetBits(d) <= info.numRegs,
                        "allocated regs: " + info.numRegs
                    )
                    switch (arg8) {
                        case OpAsync.YIELD: // A-timeout in ms
                            break
                        case OpAsync.CLOUD_UPLOAD: // A-numregs
                            rdRegs(a)
                            break
                        case OpAsync.SET_REG: // A-role, B-code
                        case OpAsync.QUERY_REG: // A-role, B-code, C-timeout
                            check(a < numRoles, "role idx")
                            check(b <= 0x1ff, "reg code")
                            break
                        default:
                            check(false, "invalid async code")
                            break
                    }
                    writtenRegs &= d
                    break
            }

            if (!isPrefixInstr(instr)) params = [0, 0, 0, 0]

            if (lastOK) writtenRegs = 0

            check(lastOK || pc + 1 < funcode.length, "final fall-off")
        }

        function check(cond: boolean, msg: string) {
            if (!cond) {
                oopsPos(
                    f.start + pc * 2,
                    "instruction verification failure: " + msg
                )
            }
        }

        function rdReg(idx: number) {
            check((writtenRegs & (1 << idx)) != 0, "register was written")
        }

        function rdRegs(num: number) {
            for (let i = 0; i < num; i++) rdReg(i)
        }

        function wrReg(idx: number) {
            writtenRegs |= 1 << idx
        }

        function verifyCell(tp: CellKind, idx: number, write: boolean) {
            check(idx >= 0, "idx pos")
            switch (tp) {
                case CellKind.LOCAL:
                    // TODO
                    break
                case CellKind.GLOBAL:
                    check(idx < numGlobals, "globals range")
                    break
                case CellKind.BUFFER: // arg=shift:numfmt, C=Offset
                    const fmt: OpFmt = idx & 0xf
                    check(
                        fmt <= OpFmt.I64 ||
                            fmt == OpFmt.F32 ||
                            fmt == OpFmt.F64,
                        "valid fmt"
                    )
                    const sz = bitSize(idx & 0xf)
                    const shift = idx >> 4
                    check(shift <= sz, "shift < sz")
                    check(c <= 236 - sz / 8, "offset in range")
                    break
                case CellKind.FLOAT_CONST:
                    check(idx < floats.length, "float const in range")
                    break
                case CellKind.IDENTITY:
                    break
                case CellKind.SPECIAL:
                    check(idx < ValueSpecial._LAST, "special in range")
                    break
                default:
                    check(false, "invalid cell kind")
            }

            switch (tp) {
                case CellKind.LOCAL:
                case CellKind.GLOBAL:
                case CellKind.BUFFER:
                    break
                default:
                    check(!write, "cell kind not writable")
                    break
            }
        }
    }
}
