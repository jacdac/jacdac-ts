import {
    addServiceProvider,
    serviceProviderDefinitionFromServiceClass,
    ServiceProviderOptions,
} from "../../servers/servers"
import { JDBus } from "../bus"
import {
    CHANGE,
    DEVICE_ANNOUNCE,
    ERROR,
    EVENT,
    RoleManagerCmd,
    ROLE_MANAGER_POLL,
    ROLE_QUERY_DEVICE,
    ROLE_QUERY_SELF_DEVICE,
    ROLE_QUERY_SERVICE_INDEX,
    ROLE_QUERY_SERVICE_OFFSET,
    SELF_ANNOUNCE,
    SystemEvent,
} from "../constants"
import { JDDevice } from "../device"
import { JDEvent } from "../event"
import { jdpack, jdunpack, PackedSimpleValue } from "../pack"
import { Packet } from "../packet"
import { InPipeReader } from "../pipes"
import { JDService } from "../service"
import { JDServiceClient } from "../serviceclient"
import {
    isConstRegister,
    isInfrastructure,
    serviceSpecificationFromClassIdentifier,
} from "../spec"
import {
    arrayConcatMany,
    debounceAsync,
    fromHex,
    groupBy,
    toHex,
    toMap,
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

/**
 * Resolves the JDom service instance for this role.
 * @param bus
 * @param role
 * @returns
 */
export function resolveRoleService(bus: JDBus, role: Role) {
    const { deviceId, serviceIndex, serviceClass } = role
    if (!deviceId || isNaN(serviceIndex)) return undefined
    const device = bus.device(deviceId, true)
    const service = device?.service(serviceIndex)
    if (service && service.serviceClass !== serviceClass) {
        console.warn("unexpected service class for role", { role })
        return undefined
    }
    return service
}

function parentName(bus: JDBus, role: Role) {
    if (role.query) {
        const args = role.query.split("&").map(a => a.split("=", 2))
        const deviceId = args.find(a => a[0] === ROLE_QUERY_DEVICE)?.[1]
        if (deviceId === ROLE_QUERY_SELF_DEVICE) return bus.selfDeviceId
        return deviceId
    }
    return role.name.split("/", 1)[0]
}

function serviceKey(service: JDService): string {
    return `${service.device.deviceId}:${service.serviceIndex}`
}

// stable ordering so re-polling identical roles never looks like a change due to device-side reordering
function compareRoles(l: Role, r: Role): number {
    return (
        l.deviceId.localeCompare(r.deviceId) ||
        l.serviceIndex - r.serviceIndex ||
        l.name.localeCompare(r.name)
    )
}

function parseRole(role: Role): ServiceProviderOptions {
    const specification = serviceSpecificationFromClassIdentifier(
        role.serviceClass
    )
    if (!specification) return undefined
    const args = role.query
        ?.split("&")
        .map(a => a.split("=", 2))
        .filter(([n, v]) => n && v !== undefined)
        .map(([n, v]) => ({ name: n.toLowerCase().trim(), value: v }))
    const serviceOffset = args
        ?.filter(arg => arg.name === ROLE_QUERY_SERVICE_OFFSET)
        .map(arg => {
            const i = parseInt(arg.value)
            return isNaN(i) ? undefined : i
        })[0]
    const serviceIndex = args
        ?.filter(arg => arg.name === ROLE_QUERY_SERVICE_INDEX)
        .map(arg => {
            const i = parseInt(arg.value)
            return isNaN(i) ? undefined : i
        })[0]
    const REG_NAME_MAP: Record<string, string> = {
        name: "instance_name",
    }
    const pktArgs = args
        ?.map(({ name, value }) => ({
            name: REG_NAME_MAP[name] || name,
            value,
        }))
        ?.map(({ name, value }) => ({
            name,
            value,
            pkt: specification.packets.find(
                pkt => isConstRegister(pkt) && pkt.name === name
            ),
        }))
        .filter(a => !!a.pkt?.packFormat)
        .map(({ name, value, pkt }) => {
            let simpleValue: PackedSimpleValue
            const type = pkt.fields[0].type
            const enumType: jdspec.EnumInfo = specification.enums?.[type]
            if (enumType)
                simpleValue = enumType.members[value] || parseInt(value)
            else if (type == "string") simpleValue = value
            else simpleValue = parseInt(value)
            return { name, value: simpleValue }
        })
    if (
        serviceOffset === undefined &&
        serviceIndex === undefined &&
        !pktArgs?.length
    )
        return undefined

    const constants: Record<string, PackedSimpleValue> =
        pktArgs &&
        toMap(
            pktArgs,
            a => a.name,
            a => a.value
        )
    const r = {
        serviceClass: role.serviceClass,
        serviceOffset,
        serviceIndex,
        constants,
    }
    console.debug(`role: ${role.name}`, r)
    return r
}

/**
 * A client for the role manager service
 * @category Clients
 */
export class RoleManagerClient extends JDServiceClient {
    private _roles: Role[] = []
    private _needRefresh = true
    private _refreshing = false
    private _lastRefreshAttempt = 0
    // roles for which a simulator/provider has already been requested but not yet
    // confirmed bound, to avoid spawning duplicates while waiting for that confirmation
    private _pendingSimRoleNames = new Set<string>()
    // roles waiting to be bound to a specific spawned device, keyed by that device's id,
    // since a freshly spawned provider isn't announced (and can't be setRole()'d) yet
    private _pendingSimDeviceRoles = new Map<string, Role[]>()
    // services with an in-flight reuse setRole() request not yet confirmed by a fresh
    // ListRoles poll; `service.role` alone isn't enough since it only updates on confirmation
    private _pendingReuseServiceKeys = new Set<string>()
    // serializes automatically-triggered setRole() calls so concurrent SetRole commands
    // don't race each other on the shared ack-tracking mechanism
    private _setRoleQueue: Promise<void> = Promise.resolve()
    public readonly changeEvent: JDEvent
    public readonly startRefreshRoles: () => void

    constructor(service: JDService) {
        super(service)
        this.changeEvent = service.event(SystemEvent.Change)

        // always debounce refresh roles
        this.startRefreshRoles = debounceAsync(
            this.refreshRoles.bind(this),
            200
        )

        // role manager emits change events
        this.mount(
            this.changeEvent.subscribe(EVENT, this.handleChange.bind(this))
        )
        // assign roles when need device enter the bus
        this.mount(
            this.bus.subscribe(
                DEVICE_ANNOUNCE,
                this.handleDeviceAnnounce.bind(this)
            )
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

    /**
     * @hidden
     */
    override toString(): string {
        return `role manager ${this.service.toString()}`
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
        if (this._refreshing) {
            // a collectRoles() round trip is already in flight; ask it to redo the work once done
            // instead of racing it with a second, overlapping request
            this._needRefresh = true
            return
        }

        this._refreshing = true
        this._needRefresh = false
        try {
            await this.collectRoles()
        } finally {
            this._refreshing = false
        }

        if (this.unmounted) return
        this.assignRoles()

        // another refresh was requested while this one was in flight
        if (this._needRefresh) this.startRefreshRoles()
    }

    private async collectRoles() {
        //this.log(`collecting roles`)
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
            for (const buf of await inp.readData(1500)) {
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
            // the device may return roles in a different order on every poll even when
            // nothing changed, so sort deterministically before diffing/storing
            roles.sort(compareRoles)
            // a role manager swap (reconnect/service replacement) may have unmounted
            // this client while the request was in flight; don't report stale results
            if (this.unmounted) return
            // store result if changed
            if (JSON.stringify(roles) !== previousRolesHash) {
                this.log(`roles updated`, roles)
                this._roles = roles
                this.emit(CHANGE)
            }
        } catch (e) {
            this.log(`collect roles failed`)
            this._needRefresh = true
            this.emit(ERROR, e)
        }
    }

    private handleDeviceAnnounce(dev: JDDevice) {
        this.assignRoles()
        this.bindPendingSimulatorRoles(dev)
    }

    // bind a just-announced, freshly spawned simulator device to the role(s) it was created for
    private bindPendingSimulatorRoles(dev: JDDevice) {
        const roles = this._pendingSimDeviceRoles.get(dev.deviceId)
        if (!roles?.length) return
        this._pendingSimDeviceRoles.delete(dev.deviceId)

        const pool = dev
            .services()
            .filter(srv => !isInfrastructure(srv.specification))
        roles.forEach(role => {
            const index = pool.findIndex(
                srv => srv.serviceClass === role.serviceClass
            )
            if (index > -1) {
                const [service] = pool.splice(index, 1)
                this._pendingReuseServiceKeys.add(serviceKey(service))
                this.queueSetRole(service, role.name)
            }
        })
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
        // confirmed by firmware, no longer need to keep this service reserved
        if (role) this._pendingReuseServiceKeys.delete(serviceKey(service))
        if (service.role !== role?.name)
            this.log(`role ${service} -> ${role?.name || ""}`, { role })
        service.role = role?.name
    }

    private clearRoles() {
        this.bus.services().forEach(srv => (srv.role = undefined))
        this._pendingSimRoleNames.clear()
        this._pendingSimDeviceRoles.clear()
        this._pendingReuseServiceKeys.clear()
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

    // chains a setRole() call onto the pending queue so automatic bindings never
    // send overlapping SetRole commands to the device
    private queueSetRole(service: JDService, name: string) {
        this._setRoleQueue = this._setRoleQueue
            .then(() => this.setRole(service, name))
            .catch(e => {
                this._pendingSimRoleNames.delete(name)
                this._pendingReuseServiceKeys.delete(serviceKey(service))
                this.log(`set role failed`, e)
            })
        return this._setRoleQueue
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
            this.log(`role unmodified, skipping`)
            return
        }

        // set new role assignment
        {
            this.log(`assign role ${deviceId}[${serviceIndex}] -> ${name}`)
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
        if (previous && previous.deviceId != "0000000000000000") {
            this.log(`clear role ${previous.deviceId}:${previous.serviceIndex}`)
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
        this.log(`start role sims`, { roles: this._roles })
        const allUnboundRoles = this._roles.filter(
            role => !this.bus.device(role.deviceId, true)
        )
        if (!allUnboundRoles?.length) return

        // drop pending markers for roles that resolved (bound) or no longer exist
        for (const name of this._pendingSimRoleNames)
            if (!allUnboundRoles.find(role => role.name === name))
                this._pendingSimRoleNames.delete(name)

        // skip roles a previous call already started a simulator for, until they
        // are confirmed bound; otherwise concurrent/repeated calls spawn duplicates
        const unboundRoles = allUnboundRoles.filter(
            role => !this._pendingSimRoleNames.has(role.name)
        )
        if (!unboundRoles.length) return

        this.log(`unbound roles: ${unboundRoles.length}`, { roles: unboundRoles })

        // collect unbound services, excluding ones with an already-requested but
        // not-yet-confirmed reuse assignment (service.role only updates on confirmation)
        const unboundServices = this.bus
            .services()
            .filter(
                srv => !srv.role && !this._pendingReuseServiceKeys.has(serviceKey(srv))
            )
        // match unbound roles with unbound services
        const stillUnbound: Role[] = []
        unboundRoles.forEach(role => {
            const serviceIndex = unboundServices.findIndex(
                srv => srv.serviceClass === role.serviceClass
            )
            if (serviceIndex > -1) {
                const service = unboundServices[serviceIndex]
                unboundServices.splice(serviceIndex, 1)
                this._pendingSimRoleNames.add(role.name)
                this._pendingReuseServiceKeys.add(serviceKey(service))
                this.queueSetRole(service, role.name)
            } else {
                stillUnbound.push(role)
            }
        })

        // collect roles that need to be bound
        const todos = groupBy(
            stillUnbound
                .map(role => ({
                    role,
                    hostDefinition: serviceProviderDefinitionFromServiceClass(
                        role.serviceClass
                    ),
                }))
                .filter(todo => !!todo.hostDefinition),
            todo => parentName(this.bus, todo.role) || ""
        )
        this.log(`simulateable roles`, todos)

        // mark all roles about to spawn a provider as pending so repeat calls skip them
        stillUnbound.forEach(role => this._pendingSimRoleNames.add(role.name))

        // spawn devices with group of devices
        const parents = Object.keys(todos)
        parents.forEach(parent => {
            const todo = todos[parent]
            // no parent, spawn individual services
            if (!parent) {
                todo.forEach(t => {
                    const serviceOptions = parseRole(t.role)
                    const provider = addServiceProvider(
                        this.bus,
                        t.hostDefinition,
                        serviceOptions ? [serviceOptions] : undefined
                    )
                    // bound once the new device announces, see handleDeviceAnnounce
                    this._pendingSimDeviceRoles.set(provider.deviceId, [
                        t.role,
                    ])
                })
            } else {
                // spawn all services into 1
                const provider = addServiceProvider(
                    this.bus,
                    {
                        name: "",
                        serviceClasses: [],
                        services: () =>
                            arrayConcatMany(
                                todo.map(t => t.hostDefinition.services())
                            ),
                    },
                    todo.map(t => parseRole(t.role)).filter(q => !!q)
                )
                // bound once the new device announces, see handleDeviceAnnounce
                this._pendingSimDeviceRoles.set(
                    provider.deviceId,
                    todo.map(t => t.role)
                )
            }
        })
    }
}
