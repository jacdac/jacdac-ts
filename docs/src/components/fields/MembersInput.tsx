import { Grid } from "@material-ui/core";
import React from "react";
import { RegisterInputVariant } from "../RegisterInput";
import MemberInput from "./MemberInput";

export default function MembersInput(props: {
    serviceSpecification: jdspec.ServiceSpec,
    serviceMemberSpecification?: jdspec.PacketInfo,
    specifications: jdspec.PacketMember[],
    values?: any[],
    setValues?: (values: any[]) => void,
    showDataType?: boolean,
    color?: "primary" | "secondary",
    variant?: RegisterInputVariant
}) {
    const { serviceSpecification, serviceMemberSpecification, specifications, values, setValues, showDataType, color, variant } = props;
    const setValue = (index: number) => (value: any) => {
        const c = values.slice(0)
        c[index] = value;
        setValues(c)
    }

    return <Grid container spacing={1}>
        {specifications.map((field, fieldi) => {
            const value = values?.[fieldi];
            return <Grid item key={fieldi} xs={12}>
                <MemberInput
                    serviceSpecification={serviceSpecification}
                    serviceMemberSpecification={serviceMemberSpecification}
                    specification={field}
                    showDataType={showDataType}
                    value={value}
                    color={color}
                    setValue={values && setValues && setValue(fieldi)}
                    variant={variant} />
            </Grid>;
        })}
    </Grid>
}
