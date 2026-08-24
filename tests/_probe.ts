import { mkBus } from "./testutils"
import { RoleManagerServer } from "../src/jdom/servers/rolemanagerserver"
import { addServer } from "../src/servers/servers"
import { DEVICE_ANNOUNCE } from "../src/jdom/constants"

async function main() {
    const bus = mkBus()
    bus.start()
    const rm = new RoleManagerServer(bus)
    const provider = addServer(bus, "rolemgr", rm)
    console.log("provider deviceId", provider.deviceId)
    bus.on(DEVICE_ANNOUNCE, (dev: any) => {
        console.log("announce", dev.deviceId, Date.now())
    })
    const t0 = Date.now()
    await new Promise(r => setTimeout(r, 1500))
    console.log("elapsed", Date.now() - t0)
    const dev = bus.device(provider.deviceId, true)
    console.log("announced?", dev?.announced, dev?.services().length)
    process.exit(0)
}
main()
