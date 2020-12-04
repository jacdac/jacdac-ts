import { Grid, Typography } from "@material-ui/core";
import React, { useContext } from "react";
import { cryptoRandomUint32, toHex } from "../../../src/jdom/utils";
// tslint:disable-next-line: no-submodule-imports match-default-export-name
import JACDACContext, { JDContextProps } from "../../../src/react/Context";
import { SRV_PROTOCOL_TEST } from "../../../src/jdom/constants";
import useChange from "../jacdac/useChange"
import { JDService } from "../../../src/jdom/service";
import { JDRegister } from "../../../src/jdom/register";
import ConnectAlert from "./ConnectAlert";
import { JDField } from "../../../src/jdom/field";
import { jdpack } from "../../../src/jdom/pack";
import DeviceName from "./DeviceName";
import DeviceActions from "./DeviceActions";
import useEffectAsync from "./useEffectAsync";
import TestCard from "./TestCard";


function pick(...values: number[]) {
    return values.find(x => x !== undefined);
}

function randomRange(min: number, max: number) {
    return Math.round(Math.random() * (max - min) + min);
}

function randomFieldPayload(field: JDField) {
    const { specification } = field;
    let r: any = undefined;
    switch (specification.type) {
        case "bool":
            r = Math.random() > 0.5 ? 1 : 0;
            break;
        case "i8":
        case "i16":
        case "i32":
        case "u8":
        case "u16":
        case "u32": {
            const unsigned = specification.type[0] === "u";
            const n = parseInt(specification.type.slice(1));
            const min = pick(specification.typicalMin, specification.absoluteMin, unsigned ? 0 : -((1 << (n - 1)) - 1));
            const max = pick(specification.typicalMax, specification.absoluteMax, unsigned ? (1 << n) - 1 : (1 << (n - 1)) - 1);
            r = randomRange(min, max);
            break;
        }
        case "bytes": {
            // maxBytes?
            const a = cryptoRandomUint32(randomRange(1, 3));
            r = new Uint8Array(a.buffer);
            break;
        }
        case "string":
        case "string0": {
            const ch_a = "a".charCodeAt(0);
            const ch_z = "z".charCodeAt(0)
            const n = randomRange(4, 10);
            let s = ""
            for (let i = 0; i < n; ++i) {
                s += String.fromCharCode(randomRange(ch_a, ch_z));
            }
            r = s;
            break;
        }
    }

    return r;
}

function randomPayload(fields: JDField[]) {
    return fields.map(randomFieldPayload);
}

function RegisterProtocolTest(props: { rw: JDRegister, ro: JDRegister }) {
    const { rw, ro } = props;
    const { specification, fields } = rw;
    const name = specification.name.replace(/^rw_/, "")

    const rxValue = r => r.decoded?.decoded?.map(d => d.humanValue || "?").join(", ") || "?";
    const rwValue = useChange(rw, rxValue);
    const roValue = useChange(ro, rxValue);

    useEffectAsync(async () => {
        await rw.sendGetAsync();
        await ro.sendGetAsync();
    }, []);

    const test = async (log) => {
        const packFormat = specification.packFormat;
        log({ packFormat })
        const payload = randomPayload(fields);
        log({ payload })
        if (!payload) throw "data layout not supported"
        if (!packFormat) throw "format unknown"

        const data = jdpack(packFormat, payload);
        const xdata = toHex(data);
        log({ data: xdata })

        // send over packet
        await rw.sendSetAsync(data, true);
        // read packet
        await rw.sendGetAsync();
        // check read
        const rwData = toHex(rw.data)
        console.log({ rwData })
        if (rwData !== xdata)
            throw `expected rw ${xdata}, got ${rwData}`
        // check ro
        await ro.sendGetAsync();
        const roData = toHex(rw.data)
        console.log({ roData })
        if (roData !== xdata)
            throw `expected ro ${xdata}, got ${roData}`
    }

    return <TestCard title={name} onTest={test}>
        <Typography>{`rw: ${rwValue}`}</Typography>
        <Typography>{`ro: ${roValue}`}</Typography>
    </TestCard>
}

function ServiceProtocolTest(props: { service: JDService }) {
    const { service } = props;
    const { device } = service;

    const regs = service.registers();
    const rws = service.registers().filter(reg => reg.specification.kind == "rw")
        .map(rw => {
            const roname = rw.name.replace(/^rw_/, "ro_");
            const ro = regs.find(r => r.specification.kind === "ro" && r.specification.name === roname)
            return { rw, ro }
        });

    return <Grid container spacing={1}>
        <Grid item xs={10}>
            <Typography variant="h4">
                <DeviceName device={device} />
            </Typography>
        </Grid>
        <Grid item xs={2}>
            <DeviceActions device={device} reset={true} />
        </Grid>
        {rws?.map(rw => <Grid item xs={12} md={6}><RegisterProtocolTest key={rw.rw.id} {...rw} /></Grid>)}
    </Grid>
}

export default function ProtocolTest() {
    const { bus } = useContext<JDContextProps>(JACDACContext)
    const services = useChange(bus, b => b.services({ serviceClass: SRV_PROTOCOL_TEST }))

    return <Grid container direction="row" spacing={2}>
        <Grid key="connect" item xs={12}>
            <ConnectAlert serviceClass={SRV_PROTOCOL_TEST} />
        </Grid>
        {services?.map(service => <Grid key={service.id} item xs={12}>
            <ServiceProtocolTest service={service} />
        </Grid>)}
    </Grid>
}