import { Button, Card, CardActions, CardContent, CardHeader, Typography } from "@material-ui/core";
import React, { useContext } from "react";
import { prettyDuration } from "../../../src/jdom/pretty";
import Trace from "../../../src/jdom/trace";
import AppContext, { DrawerType } from "./AppContext";
import PacketsContext from "./PacketsContext";

export default function TraceCard(props: { name: string, trace: Trace }) {
    const { name, trace } = props;
    const { description, duration, length } = trace;
    const { setReplayTrace, toggleTracing } = useContext(PacketsContext)
    const { setDrawerType } = useContext(AppContext)

    const handleClick = () => {
        setDrawerType(DrawerType.Packets)
        setReplayTrace(trace)
        toggleTracing();
    }

    return <Card>
        <CardHeader
            title={name}
            subheader={`${prettyDuration(duration)}, ${length} packets`}
        />
        <CardContent>
            {description && <ReactMarkdown source={description} />}
        </CardContent>
        <CardActions>
            <Button onClick={handleClick} variant="outlined">import</Button>
        </CardActions>
    </Card>
}