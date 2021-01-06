import React from "react";
import { JDService } from "../../../src/jdom/service";
import { isRegister } from "../../../src/jdom/spec";
import RegisterInput from "./RegisterInput";
import useChange from '../jacdac/useChange';
import AutoGrid from "./ui/AutoGrid";
import { JDRegister } from "../../../src/jdom/register";

export default function ServiceRegisters(props: {
    service: JDService,
    registerIdentifiers?: number[],
    filter?: (register: JDRegister) => boolean,
    showRegisterName?: boolean,
    hideMissingValues?: boolean
}) {
    const { service, registerIdentifiers, filter, showRegisterName, hideMissingValues } = props;
    const specification = useChange(service, spec => spec.specification);
    const packets = specification?.packets;
    const ids = registerIdentifiers
        || packets
            ?.filter(pkt => isRegister(pkt))
            ?.map(pkt => pkt.identifier);
    const registers = ids?.map(id => service.register(id))
        ?.filter(reg => !!reg)
        ?.filter(reg => !filter || filter(reg))

    return <AutoGrid spacing={1}>
        {registers.map(register => <RegisterInput key={register.id}
            register={register}
            showRegisterName={showRegisterName}
            hideMissingValues={hideMissingValues}
        />)}
    </AutoGrid>
}