import { Grid } from "@material-ui/core";
import React from "react";
import { ButtonReg } from "../../../../src/jdom/constants";
import { DashboardServiceProps } from "./DashboardServiceView";
import ButtonWidget from "../widgets/ButtonWidget";
import { useRegisterUnpackedValue } from "../../jacdac/useRegisterValue";
import useWidgetSize from "../widgets/useWidgetSize";

export default function DashboardButton(props: DashboardServiceProps) {
    const { service } = props;
    const [pressed] = useRegisterUnpackedValue<[boolean]>(service.register(ButtonReg.Pressed));
    const widgetSize = useWidgetSize();

    return <Grid item>
        <ButtonWidget checked={!!pressed} color={"primary"} size={widgetSize} />
    </Grid>
}