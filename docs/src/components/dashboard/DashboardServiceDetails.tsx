import React, { useMemo } from "react";
import { SystemReg } from "../../../../src/jdom/constants";
import useChange from "../../jacdac/useChange";
import RegisterInput from "../RegisterInput";
import { isRegister } from "../../../../src/jdom/spec";
import { DashboardServiceProps } from "./DashboardServiceWidget";
import { Grid } from "@material-ui/core";

// filter out common registers
const ignoreRegisters = [
    SystemReg.StatusCode,
    SystemReg.StreamingPreferredInterval,
    SystemReg.StreamingSamples,
    SystemReg.StreamingInterval
]
const collapsedRegisters = [
    SystemReg.Reading,
    SystemReg.Value,
    SystemReg.Intensity
]

export default function DashboardServiceDetails(props: DashboardServiceProps) {
    const { service, expanded } = props;
    const specification = useChange(service, spec => spec.specification);
    const registers = useMemo(() => {
        const packets = specification?.packets;
        let ids = packets
            ?.filter(pkt => isRegister(pkt))
            ?.map(pkt => pkt.identifier) || []
        ids = ids.filter(id => ignoreRegisters.indexOf(id) < 0)
        if (!expanded) // grab the first interresting register
            ids = ids.filter(id => collapsedRegisters.indexOf(id) > -1)
                .slice(0, 1);
        return ids.map(id => service.register(id))
            .filter(reg => !!reg);
    }, [specification, expanded])

    if (!registers?.length)  // nothing to see here
        return null;

    return <>
        {registers.map(register => {
            const showTrend = register.code === SystemReg.Reading;
            const xs = showTrend ? 12 : true;
            return <Grid key={register.id} item xs={xs}><RegisterInput
                register={register}
                showServiceName={true}
                showRegisterName={true}
                hideMissingValues={false}
                showTrend={showTrend}
            /></Grid>
        })}
    </>
}
