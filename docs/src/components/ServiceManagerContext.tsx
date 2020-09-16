import React, { createContext, useContext, useEffect } from "react";
import { JSONTryParse, SMap } from "../../../src/dom/utils";
import { BrowserFileStorage, HostedFileStorage, IFileStorage } from '../../../src/embed/filestorage'
import { IThemeMessage } from "../../../src/embed/protocol";
import { HTMLIFrameTransport } from "../../../src/embed/transport";
import DarkModeContext from "./DarkModeContext";
import JACDACContext from '../../../src/react/Context';
import { JDDevice } from "../../../src/dom/device";

export interface ISettings {
    get(key: string): string;
    set(key: string, value: string): void;
    clear(): void;
}

export class LocalStorageSettings implements ISettings {
    private live: SMap<string>
    constructor(private readonly key: string) {
        this.live = JSONTryParse(typeof window !== "undefined"
            && window.localStorage.getItem(key)) || {}
    }
    get(key: string): string {
        return this.live[key]
    }
    set(key: string, value: string): void {
        if (value === undefined || value === null)
            delete this.live[key]
        else
            this.live[key] = value;
        if (typeof window !== "undefined")
            window.localStorage.setItem(this.key, JSON.stringify(this.live, null, 2))
    }
    clear() {
        this.live = {}
        if (typeof window !== "undefined")
            window.localStorage.removeItem(this.key)
    }
}

export interface ServiceManagerContextProps {
    isHosted: boolean;
    fileStorage: IFileStorage;
    deviceNames: ISettings;
}

const ServiceManagerContext = createContext<ServiceManagerContextProps>({
    isHosted: false,
    fileStorage: null,
    deviceNames: null
});
ServiceManagerContext.displayName = "Services";

export const ServiceManagerProvider = ({ children }) => {
    const { toggleDarkMode } = useContext(DarkModeContext)
    const { bus } = useContext(JACDACContext)
    const isHosted = inIFrame();
    let fileStorage: IFileStorage = new BrowserFileStorage()
    let deviceNames: ISettings = new LocalStorageSettings("jacdac_device_names");
    if (isHosted) {
        console.log(`starting hosted services`)
        const transport = new HTMLIFrameTransport()
        fileStorage = new HostedFileStorage(transport)

        // notify host that we are ready
        transport.postReady()
    }
    const value = {
        isHosted,
        fileStorage,
        deviceNames
    }

    const handleMessage = (ev: MessageEvent<any>) => {
        const msg = ev.data;
        if (msg?.source !== 'jacdac')
            return;
        console.log(msg)
        switch (msg.type) {
            case 'theme': {
                const themeMsg = msg as IThemeMessage
                toggleDarkMode(themeMsg.data.type);
                break;
            }
        }
    }

    // receiving messages
    useEffect(() => {
        bus.host.deviceNamer = (device: JDDevice) => deviceNames.get(device.deviceId)
        window.addEventListener('message', handleMessage, false)
        return () => window.removeEventListener('message', handleMessage)
    }, [])

    return <ServiceManagerContext.Provider value={value}>
        {children}
    </ServiceManagerContext.Provider>
}

function inIFrame() {
    try {
        return typeof window !== "undefined"
            && window.self !== window.top
    } catch (e) {
        return true;
    }
}

export default ServiceManagerContext;