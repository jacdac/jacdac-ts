import {
    addServiceProvider,
    serviceProviderDefinitionFromServiceClass,
} from "../../servers/servers"
import { JDBus } from "../bus"
import {
    CHANGE,
    DEVICE_ANNOUNCE,
    ERROR,
    EVENT,
    RoleManagerCmd,
    ROLE_MANAGER_POLL,
    SELF_ANNOUNCE,
    SystemEvent,
} from "../constants"
import { jdpack, jdunpack } from "../pack"
import { Packet } from "../packet"
import { InPipeReader } from "../pipes"
import { JDService } from "../service"
import { JDServiceClient } from "../serviceclient"
import { isInfrastructure } from "../spec"
import {
    arrayConcatMany,
    debounceAsync,
    fromHex,
    groupBy,
    toHex,
} from "../utils"

/**
 * A service role assigment
 * @category Clients
 */
export interface Role {
    /**
     * Identifier of the bound device
     */
    deviceId: string
    /**
     * Service class bound, for sanity check
     */
    serviceClass: number
    /**
     * Service index bound
     */
    serviceIndex: number
    /**
     * Role name
     */
    name: string
    /**
     * Query argument (optional)
     */
    query?: string
}
function parentName(bus: JDBus, role: Role) {
    if (role.query) {
        const args = role.query.split("&").map(a => a.split("=", 2))
        const deviceId = args.find(a => a[0] === "device")?.[1]
        if (deviceId === "self") return bus.selfDeviceId
        return deviceId
    }
    return role.name.split("/", 1)[0]
}

/**
 * A client for the role manager service
 * @category Clients
 */
export class RoleManagerClient extends JDServiceClient {
    private _roles: Role[] = []
    private _needRefresh = true
    private _lastRefreshAttempt = 0

    public readonly startRefreshRoles: () => void

    constructor(service: JDService) {
        super(service)
        const changeEvent = service.event(SystemEvent.Change)

        // always debounce refresh roles
        this.startRefreshRoles = debounceAsync(
            this.refreshRoles.bind(this),
            200
        )

        // role manager emits change events
        this.mount(changeEvent.subscribe(EVENT, this.handleChange.bind(this)))
        // assign roles when need device enter the bus
        this.mount(
            this.bus.subscribe(DEVICE_ANNOUNCE, this.assignRoles.bind(this))
        )
        // clear on unmount
        this.mount(this.clearRoles.bind(this))
        // retry to get roles on every self-announce
        this.mount(
            this.bus.subscribe(
                SELF_ANNOUNCE,
                this.handleSelfAnnounce.bind(this)
            )
        )
    }

    private handleSelfAnnounce() {
        if (
            this._needRefresh &&
            this.bus.timestamp - this._lastRefreshAttempt > ROLE_MANAGER_POLL
        )
            this.startRefreshRoles()
    }

    get roles() {
        return this._roles
    }

    private async handleChange() {
        this.startRefreshRoles()
    }

    private async refreshRoles() {
        if (this.unmounted) return

        this._needRefresh = false
        await this.collectRoles()

        if (this.unmounted) return
        this.assignRoles()
    }

    private async collectRoles() {
        this._lastRefreshAttempt = this.bus.timestamp
        const previousRolesHash = JSON.stringify(this._roles)
        try {
            const inp = new InPipeReader(this.bus)
            await this.service.sendPacketAsync(
                inp.openCommand(RoleManagerCmd.ListRoles),
                true
            )
            // collect all roles
            const roles: Role[] = []
            for (const buf of await inp.readData(1000)) {
                const [devidbuf, serviceClass, serviceIndex, full] = jdunpack<
                    [Uint8Array, number, number, string]
                >(buf, "b[8] u32 u8 s")
                const deviceId = toHex(devidbuf)
                const [name, query] = full.split("?", 2)
                const role: Role = {
                    deviceId,
                    serviceClass,
                    serviceIndex,
                    name,
                    query,
                }
                roles.push(role)
            }
            // store result if changed
            if (JSON.stringify(roles) !== previousRolesHash) {
                this._roles = roles
                this.emit(CHANGE)
            }
        } catch (e) {
            this._needRefresh = true
            this.emit(ERROR, e)
        }
    }

    private assignRoles() {
        this.bus
            .services()
            .filter(srv => !isInfrastructure(srv.specification))
            .forEach(srv => this.assignRole(srv))
    }

    private assignRole(service: JDService) {
        const deviceId = service.device.deviceId
        const serviceIndex = service.serviceIndex
        const role = this._roles.find(
            r => r.deviceId === deviceId && r.serviceIndex === serviceIndex
        )
        //console.debug(`role ${service.id} -> ${role?.role}`, { service })
        service.role = role?.name
    }

    private clearRoles() {
        this.bus.services().forEach(srv => (srv.role = undefined))
    }

    hasRoleForService(service: JDService) {
        const { serviceClass } = service
        return !!this._roles?.find(r => r.serviceClass === serviceClass)
    }

    compatibleRoles(service: JDService): Role[] {
        const { serviceClass } = service
        return this._roles?.filter(r => r.serviceClass === serviceClass)
    }

    role(name: string): Role {
        return this._roles.find(r => r.serviceIndex > 0 && r.name === name)
    }

    async setRole(service: JDService, name: string) {
        const { device, serviceIndex } = service
        const { deviceId } = device
        //console.debug(`set role ${deviceId}:${serviceIndex} to ${role}`)

        const previous = name && this._roles.find(r => r.name === name)
        if (
            previous &&
            previous.deviceId === deviceId &&
            previous.serviceIndex === serviceIndex
        ) {
            // nothing todo
            console.debug(`role unmodified, skipping`)
            return
        }

        // set new role assignment
        {
            const data = jdpack<[Uint8Array, number, string]>("b[8] u8 s", [
                fromHex(deviceId),
                serviceIndex,
                name || "",
            ])
            await this.service.sendPacketAsync(
                Packet.from(RoleManagerCmd.SetRole, data),
                true
            )
        }

        // clear previous role assignment
        if (previous) {
            console.debug(
                `clear role ${previous.deviceId}:${previous.serviceIndex}`
            )
            const data = jdpack<[Uint8Array, number, string]>("b[8] u8 s", [
                fromHex(previous.deviceId),
                previous.serviceIndex,
                "",
            ])
            await this.service.sendPacketAsync(
                Packet.from(RoleManagerCmd.SetRole, data),
                true
            )
        }
    }

    allRolesBound() {
        return this._roles.every(role => !!this.bus.device(role.deviceId, true))
    }

    startSimulators() {
        const roles = this._roles.filter(
            role => !this.bus.device(role.deviceId, true)
        )
        if (!roles?.length) return

        // collect roles that need to be bound
        const todos = groupBy(
            roles
                .map(role => ({
                    role,
                    hostDefinition: serviceProviderDefinitionFromServiceClass(
                        role.serviceClass
                    ),
                }))
                .filter(todo => !!todo.hostDefinition),
            todo => parentName(this.bus, todo.role) || ""
        )

        // spawn devices with group of devices
        const parents = Object.keys(todos)
        parents.forEach(parent => {
            const todo = todos[parent]
            // no parent, spawn individual services
            if (!parent) {
                todo.forEach(t =>
                    addServiceProvider(this.bus, t.hostDefinition)
                )
            } else {
                // spawn all services into 1
                addServiceProvider(this.bus, {
                    name: "",
                    serviceClasses: [],
                    services: () =>
                        arrayConcatMany(
                            todo.map(t => t.hostDefinition.services())
                        ),
                })
            }
        })
    }
}
