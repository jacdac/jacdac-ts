import React from "react"
import IDChip from "./IDChip";
import { Link } from 'gatsby-theme-material-ui';
import { identifierToUrlPath, imageDeviceOf, serviceSpecificationFromClassIdentifier } from "../../../src/jdom/spec"
import ServiceSpecificationCard from "./ServiceSpecificationCard";
import { Grid, Typography } from "@material-ui/core";
import useGridBreakpoints from "./useGridBreakpoints";
import DeviceSpecificationSource from "./DeviceSpecificationSource";
import FirmwareCard from "./firmware/FirmwareCard"
import { escapeDeviceIdentifier } from "../../../jacdac-spec/spectool/jdspec"
import ReactMarkdown from "react-markdown"

export default function DeviceSpecification(props: { device: jdspec.DeviceSpec, showSource?: string }) {
    const { device, showSource } = props;
    const gridBreakpoints = useGridBreakpoints();

    return <>
        <h2 key="title">
            <Link to={device.link}>{device.name}</Link>
        </h2>
        <Typography variant="subtitle1">by <Link to={`/devices/${identifierToUrlPath(escapeDeviceIdentifier(device.company))}`}>{device.company}</Link></Typography>
        {<img alt="image of the device" src={imageDeviceOf(device)} />}
        {device.description && <ReactMarkdown source={device.description} />}
        {device.repo && <FirmwareCard slug={device.repo} />}
        {!!device.firmwares.length && <><h3>Firmware identifiers</h3>
            <ul>
                {device.firmwares.map(firmware => <li key={firmware}><IDChip id={firmware} filter={`fw:0x${firmware.toString(16)}`} /></li>)}
            </ul></>}
        <h3>Services</h3>
        <Grid container spacing={2}>
            {device.services.map(sc => serviceSpecificationFromClassIdentifier(sc))
                .map(spec => <Grid item key={spec.shortId} {...gridBreakpoints}>
                    <ServiceSpecificationCard specification={spec} />
                </Grid>)}
        </Grid>
        {showSource && <>
            <h2>Specification</h2>
            <DeviceSpecificationSource deviceSpecification={device}
                showJSON={true} showDTDL={true} />
        </>}
    </>
}
