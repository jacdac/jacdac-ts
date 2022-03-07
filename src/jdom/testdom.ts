import { JDBus } from "./bus"
import {
    BaseReg,
    CHANGE,
    ControlReg,
    DEVICE_ANNOUNCE,
    DISCONNECT,
    EVENT,
    LedCmd,
    LedDisplayReg,
    LedStripCmd,
    REPORT_UPDATE,
    SRV_BUTTON,
    SRV_CONTROL,
    SRV_LED,
    SRV_LED_DISPLAY,
    SRV_LED_STRIP,
    SRV_POTENTIOMETER,
    SystemReg,
    SystemStatusCodes,
} from "./constants"
import { JDDevice } from "./device"
import { JDEvent } from "./event"
import { JDSubscriptionScope } from "./eventsource"
import { lightEncode } from "./light"
import { JDNode } from "./node"
import { jdpack } from "./pack"
import { serviceName } from "./pretty"
import { randomDeviceId } from "./random"
import { JDRegister } from "./register"
import { JDService } from "./service"
import {
    isEvent,
    isReading,
    serviceSpecificationFromClassIdentifier,
    serviceSpecificationFromName,
} from "./spec"
import { delay, JSONTryParse } from "./utils"

export const PANEL_TEST_KIND = "panelTest"
export const DEVICE_TEST_KIND = "deviceTest"
export const SERVICE_TEST_KIND = "serviceTest"
export const SERVICE_COMMAND_TEST_KIND = "serviceCommandTest"
export const REGISTER_TEST_KIND = "registerTest"
export const EVENT_TEST_KIND = "eventTest"
export const REGISTER_ORACLE_KIND = "registerOracle"

export enum TestState {
    Pass,
    Indeterminate,
    Running,
    Fail,
}

export interface TestResult {
    state: TestState
    output?: string
}

export type TestLogger = (msg: string) => void

export abstract class TestNode extends JDNode {
    private readonly _id: string = randomDeviceId()
    private _parent: TestNode
    private _state: TestState = TestState.Indeterminate
    private _output: string
    private _node: JDNode = undefined
    private _children: TestNode[] = []
    protected readonly subscriptions = new JDSubscriptionScope()

    constructor(private _name: string) {
        super()
    }

    get name(): string {
        return this._name
    }

    protected set name(value: string) {
        if (value !== this._name) {
            this._name = value
            this.emit(CHANGE)
        }
    }

    get label(): string {
        return this._name
    }

    get info(): string {
        return undefined
    }

    get id() {
        return this._id
    }
    get parent() {
        return this._parent
    }
    private set parent(value: TestNode) {
        if (value !== this._parent) {
            this.node = undefined
            this._parent = value
        }
    }
    get node(): JDNode {
        return this._node
    }
    set node(value: JDNode) {
        if (value !== this._node) {
            if (this._node) {
                //console.log(`unbound ${this._node} from ${this}`)
            }
            this.unmount()
            this._node = value
            this.bindChildren()
            if (value) {
                //console.log(`bound ${value} to ${this}`)
                this.mount()
                this.updateState()
            } else this.state = TestState.Indeterminate
        }
    }

    private handleChange() {
        this.bindChildren()
        this.updateState()
    }

    private bindChildren() {
        if (this.node) this._children.forEach(c => c.bind())
        else this._children.forEach(c => (c.node = undefined))
    }

    protected updateState(): void {
        // compute local state
        const { state, output } = this.nodeState()
        this.output = output
        if (this.children.length === 0 || state === TestState.Fail)
            this.state = state
        // compute child states
        else this.state = this.computeChildrenState()
    }

    resolveOracle(reg: JDRegister): RegisterOracle {
        return this.parent?.resolveOracle(reg)
    }

    protected nodeState(): TestResult {
        return {
            state: this.node ? TestState.Running : TestState.Indeterminate,
        }
    }

    protected mount() {
        this.subscriptions.mount(
            this.node.subscribe(CHANGE, this.handleChange.bind(this))
        )
    }

    protected unmount() {
        this.subscriptions.unmount()
        this._children.forEach(c => c.unmount())
    }

    get children(): TestNode[] {
        return this._children.slice(0)
    }

    appendChild(child: TestNode) {
        if (child && this._children.indexOf(child) < 0) {
            this._children.push(child)
            child.parent = this
            if (this.node) child.bind()
            else child.node = undefined
            this.emit(CHANGE)
            this.updateState()
        }
    }

    protected bind() {}

    get qualifiedName(): string {
        return this._parent ? `${this.parent}:${this.name}` : this.name
    }

    get state() {
        return this._state
    }
    set state(value: TestState) {
        if (value != this._state) {
            this._state = value
            this.emit(CHANGE)
            this.parent?.updateState()
        }
    }

    get output() {
        return this._output
    }

    protected set output(value: string) {
        if (this._output !== value) {
            this._output = value
            this.emit(CHANGE)
        }
    }

    protected computeChildrenState() {
        return this._children.reduce(
            (s, c) => Math.max(s, c.state),
            TestState.Pass
        )
    }

    override toString(): string {
        return this.qualifiedName
    }

    export(): object {
        const children = this.children.map(child => child.export())
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res: any = {
            name: this.name,
            state: TestState[this.state]?.toLowerCase(),
            kind: this.nodeKind,
            ...this.customProperties(),
        }
        if (this.output) res.output = this.output
        if (children.length > 0) res.children = children
        return res
    }

    protected customProperties(): object {
        return {}
    }
}

export class PanelTest extends TestNode {
    constructor(id: string, readonly specification: PanelTestSpec) {
        super(id || "panel")
    }
    get nodeKind(): string {
        return PANEL_TEST_KIND
    }
    get bus() {
        return this.node as JDBus
    }
    set bus(value: JDBus) {
        this.node = value
    }
    get deviceTests() {
        return this.children as DeviceTest[]
    }
    override resolveOracle(reg: JDRegister): RegisterOracle {
        return this.children
            .filter(c => c.nodeKind === REGISTER_ORACLE_KIND)
            .map<RegisterOracle>(c => <RegisterOracle>c)
            .filter(c => !!c.register)
            .find(
                (o: RegisterOracle) =>
                    o.serviceClass === reg.service.serviceClass &&
                    o.code === reg.code
            )
    }
    override get label() {
        const children = this.children.filter(
            c => c.nodeKind === DEVICE_TEST_KIND
        )
        const found = children.filter(c => !!c.node).length
        return `${this.name}, found ${found}/${children.length} devices`
    }

    override mount(): void {
        super.mount()
        this.subscriptions.mount(
            this.bus.subscribe(DEVICE_ANNOUNCE, (dev: JDDevice) => {
                dev.refreshFirmwareInfo()
            })
        )
    }

    override customProperties(): object {
        return {
            time: new Date().toUTCString(),
            userAgent: typeof navigator !== "undefined" && navigator?.userAgent,
        }
    }
}

export class DeviceTest extends TestNode {
    constructor(
        readonly productIdentifier: number,
        readonly specification: jdspec.DeviceSpec
    ) {
        super(
            specification
                ? `${specification.name} (0x${productIdentifier.toString(16)})`
                : `0x${productIdentifier.toString(16)}`
        )
    }
    get nodeKind(): string {
        return DEVICE_TEST_KIND
    }
    get device() {
        return this.node as JDDevice
    }
    set device(value: JDDevice) {
        this.node = value
    }

    get serviceTests() {
        return this.children.filter(
            child => child.nodeKind === SERVICE_TEST_KIND
        ) as ServiceTest[]
    }

    test(device: JDDevice): boolean {
        return this.productIdentifier === device.productIdentifier
    }

    bind(): void {
        // clear bindings if needed
        if (this.device) {
            if (!this.device.connected) this.device = undefined
            // already bound
            else return
        }

        if (!this.parent) return

        const { deviceTests, specification, bus } = this.parent as PanelTest
        const { oracles } = specification

        // list unbound devices on the bus
        const unboundDevices = bus
            .devices({ ignoreInfrastructure: true })
            // ignore devices that are already bound
            .filter(d => !deviceTests.some(t => t.device === d))
            // ignore oracles
            .filter(
                d => !oracles?.find(oracle => oracle.deviceId === d.deviceId)
            )
        // quadratic search, find first device that matches a test
        const device = unboundDevices.find(d => this.test(d))
        this.device = device
    }

    protected mount(): void {
        super.mount()
        const device = this.device
        this.subscriptions.mount(
            device.subscribe(DISCONNECT, () => {
                if (device === this.node) this.node = undefined
            })
        )
    }

    protected customProperties(): object {
        const d = this.device
        if (!d) return {}
        return {
            deviceId: d.deviceId,
            shortId: d.shortId,
            firmwareVersion: d.firmwareVersion,
        }
    }
}

export class ServiceTest extends TestNode {
    constructor(name: string, readonly serviceClass: number) {
        super(name)
    }
    get nodeKind(): string {
        return SERVICE_TEST_KIND
    }
    get service() {
        return this.node as JDService
    }
    set service(value: JDService) {
        this.node = value
    }

    test(service: JDService) {
        return service.serviceClass === this.serviceClass
    }

    override bind(): void {
        if (this.service || !this.parent) return
        const { serviceTests, device } = this.parent as DeviceTest
        const unboundServices = device
            .services({
                serviceClass: this.serviceClass,
            })
            .filter(srv => !serviceTests.find(st => st.node === srv))
        const service = unboundServices.find(srv => this.test(srv))
        this.service = service
    }

    override customProperties(): object {
        const s = this.service
        if (!s) return {}
        return {
            serviceIndex: s.serviceIndex,
        }
    }
}

export abstract class ServiceMemberTestNode extends TestNode {
    constructor(name: string) {
        super(name)
    }
    get service(): JDService {
        if (!this.parent) return undefined
        const { service } = this.parent as ServiceTest
        return service
    }
}

export interface ServiceMemberOptions {
    name: string
    start: (test: ServiceMemberTestNode) => () => void
}

export class ServiceCommandsTest extends ServiceMemberTestNode {
    constructor(readonly options: ServiceMemberOptions) {
        super(options.name)
    }
    get nodeKind(): string {
        return SERVICE_COMMAND_TEST_KIND
    }
    override mount(): void {
        super.mount()

        const service = this.service
        const { start } = this.options
        if (service) {
            const unsubscribe = start(this)
            this.subscriptions.mount(unsubscribe)
        }
    }
    override bind() {
        this.node = this.service
    }
}

export abstract class RegisterTestNode extends ServiceMemberTestNode {
    constructor(name: string, readonly code: number) {
        super(name)
    }
    get register() {
        return this.node as JDRegister
    }
    set register(value: JDRegister) {
        this.node = value
    }
    override mount() {
        super.mount()
        const register = this.register
        //console.log(`register subscribe ${this.code} to ${register}`)
        this.subscriptions.mount(
            register.subscribe(REPORT_UPDATE, () => {
                this.updateState()
            })
        )
    }
    override get info(): string {
        return this.register?.humanValue || "?"
    }
}

export class RegisterOracle extends RegisterTestNode {
    constructor(
        name: string,
        readonly deviceId: string,
        readonly serviceIndex: number,
        readonly serviceClass: number,
        readonly tolerance: number
    ) {
        super(name, SystemReg.Reading)
    }

    get nodeKind(): string {
        return REGISTER_ORACLE_KIND
    }

    override nodeState(): TestResult {
        return {
            state: this.register?.unpackedValue?.length
                ? TestState.Pass
                : TestState.Fail,
        }
    }

    override bind(): void {
        if (this.register || !this.parent) return

        const { bus } = this.parent as PanelTest
        const device = bus.device(this.deviceId, true)
        const service = device?.services({
            serviceIndex: this.serviceIndex,
            serviceClass: this.serviceClass,
        })[0]
        const register = service?.register(this.code)
        this.register = register
    }
}

export class RegisterTest extends RegisterTestNode {
    constructor(
        name: string,
        code: number,
        readonly computeState: (
            node: RegisterTest,
            logger: TestLogger
        ) => TestState
    ) {
        super(name, code)
    }
    get nodeKind(): string {
        return REGISTER_TEST_KIND
    }

    override nodeState(): TestResult {
        const register = this.register
        const log: string[] = []
        const logger = (msg: string) => {
            msg && log.push(msg)
        }
        let state = TestState.Indeterminate
        if (register) {
            try {
                state = this.computeState(this, logger)
            } catch (e) {
                state = TestState.Fail
                logger(e?.toString())
            }
        }
        return {
            state,
            output: log.join("\n"),
        }
    }

    override bind(): void {
        const service = this.service
        const register = service?.register(this.code)
        this.register = register
    }
}

export class EventTest extends ServiceMemberTestNode {
    constructor(
        name: string,
        readonly code: number,
        readonly computeState: (
            node: EventTest,
            logger: TestLogger
        ) => TestState
    ) {
        super(name)
    }
    get nodeKind(): string {
        return EVENT_TEST_KIND
    }
    get event() {
        return this.node as JDEvent
    }
    set event(value: JDEvent) {
        this.node = value
    }

    override mount() {
        super.mount()
        const event = this.event
        //console.log(`event subscribe ${this.code} to ${event}`)
        this.subscriptions.mount(
            event.subscribe(EVENT, () => {
                this.updateState()
            })
        )
    }

    override nodeState(): TestResult {
        const event = this.event
        const log: string[] = []
        const logger = (msg: string) => {
            msg && log.push(msg)
        }
        let state = TestState.Indeterminate
        if (event) {
            try {
                state = this.computeState(this, logger)
            } catch (e) {
                state = TestState.Fail
                logger(e?.toString())
            }
        }
        return {
            state,
            output: log.join("\n"),
        }
    }

    override bind(): void {
        const service = this.service
        const event = service?.event(this.code)
        this.event = event
    }

    override get info(): string {
        const c = this.event?.count
        return c ? `#${c}` : "?"
    }
}

export interface PanelTestSpec {
    id?: string
    devices: DeviceTestSpec[]
    oracles?: OrableTestSpec[]
}

export interface OrableTestSpec {
    serviceClass: number
    deviceId: string
    serviceIndex?: number
    tolerance?: number
}

export interface DeviceTestSpec {
    productIdentifier: number
    count: number
    firmwareVersion?: string
    services: ServiceTestSpec[]
}

export interface ServiceTestSpec {
    name?: string
    serviceClass: number
    count?: number
    rules?: ServiceTestRule[]
    disableBuiltinRules?: boolean
}

export interface ServiceTestRule {
    type: "reading" | "oracleReading" | "event"
}
export interface ReadingTestRule extends ServiceTestRule {
    type: "reading"
    value: number
    tolerance?: number
}
export interface OracleReadingTestRule extends ServiceTestRule {
    type: "oracleReading"
    oracle: OrableTestSpec
    tolerance?: number
}
export interface EventTestRule extends ServiceTestRule {
    type: "event"
    name: string
}

const builtinTestRules: Record<number, ServiceTestRule[]> = {
    [SRV_BUTTON]: <ServiceTestRule[]>[
        <ReadingTestRule>{
            type: "reading",
            value: 0,
            tolerance: 0.001,
        },
        <ReadingTestRule>{
            type: "reading",
            value: 1,
            tolerance: 0.001,
        },
        <EventTestRule>{
            type: "event",
            name: "down",
        },
        <EventTestRule>{
            type: "event",
            name: "up",
        },
    ],
    [SRV_POTENTIOMETER]: <ServiceTestRule[]>[
        <ReadingTestRule>{
            type: "reading",
            value: 0,
            tolerance: 0.01,
        },
        <ReadingTestRule>{
            type: "reading",
            value: 1,
            tolerance: 0.01,
        },
    ],
}

const testColors = [0xff0000, 0x00ff00, 0x0000ff, 0]
const builtinServiceCommandTests: Record<number, ServiceMemberOptions> = {
    [SRV_LED_DISPLAY]: {
        name: "cycle red, gree, blue colors on all LEDs",
        start: test => {
            const service = test.service
            let mounted = true
            const work = async () => {
                const pixelsRegister = service.register(LedDisplayReg.Pixels)
                const numPixelsRegister = service.register(
                    LedDisplayReg.NumPixels
                )
                let n: number = undefined
                while (n === undefined && mounted) {
                    await numPixelsRegister.refresh(true)
                    n = numPixelsRegister.uintValue
                }
                const pixels = new Uint8Array(n * 3)
                let k = 0
                while (mounted) {
                    const color = testColors[k++ % testColors.length]
                    for (let i = 0; i < n; ++i) {
                        pixels[i * 3] = (color >> 16) & 0xff
                        pixels[i * 3 + 1] = (color >> 8) & 0xff
                        pixels[i * 3 + 2] = (color >> 0) & 0xff
                    }
                    await pixelsRegister.sendSetPackedAsync([pixels], true)
                    await delay(500)
                    if (k > testColors.length) test.state = TestState.Pass
                }
            }
            work()
            return () => {
                mounted = false
            }
        },
    },
    [SRV_LED_STRIP]: {
        name: "cycle red, green, blue colors on all LEDs",
        start: test => {
            let mounted = true
            const work = async () => {
                const service = test.service
                let k = 0
                while (mounted) {
                    const color = testColors[k++ % testColors.length]
                    const encoded = lightEncode(
                        `setall #
                            show 20`,
                        [color]
                    )
                    await service?.sendCmdAsync(LedStripCmd.Run, encoded)
                    await delay(500)

                    if (k > testColors.length) test.state = TestState.Pass
                }
            }
            work()
            return () => {
                mounted = false
            }
        },
    },
    [SRV_LED]: {
        name: "cycles through RGB every 0.5s",
        start: test => {
            let mounted = true
            const pack = (
                r: number,
                g: number,
                b: number,
                animDelay: number
            ) => {
                const unpacked: [number, number, number, number] = [
                    r,
                    g,
                    b,
                    animDelay,
                ]
                return jdpack("u8 u8 u8 u8", unpacked)
            }
            const work = async () => {
                test.state = TestState.Running
                while (mounted) {
                    const service = test.service
                    if (!service) {
                        await delay(500)
                        return
                    }
                    await service.sendCmdAsync(
                        LedCmd.Animate,
                        pack(255, 0, 0, 200)
                    )
                    await delay(500)
                    if (!mounted) return
                    await service.sendCmdAsync(
                        LedCmd.Animate,
                        pack(0, 255, 0, 200)
                    )
                    await delay(500)
                    if (!mounted) return
                    await service.sendCmdAsync(
                        LedCmd.Animate,
                        pack(0, 0, 255, 200)
                    )
                    await delay(500)
                    if (!mounted) return
                    await service.sendCmdAsync(
                        LedCmd.Animate,
                        pack(0, 0, 0, 200)
                    )
                    await delay(500)

                    test.state = TestState.Pass
                }
            }
            // start work async
            work()
            return () => {
                mounted = false
            }
        },
    },
}

function createReadingRule(
    rule: ReadingTestRule
): (node: RegisterTest, logger: TestLogger) => TestState {
    const threshold = 2
    let samples = 0
    let seen = samples >= threshold
    const { value, tolerance } = rule
    return (node, logger) => {
        if (!seen) {
            const { register } = node
            const [current] = register.unpackedValue
            const active =
                current !== undefined &&
                (tolerance <= 0
                    ? current === value
                    : Math.abs(current - value) <= tolerance)
            if (active) samples++
            else samples = 0
            // recompute
            seen = samples >= threshold
        }
        if (!seen) logger(`missing or incorrect reading value`)
        return seen ? TestState.Pass : TestState.Fail
    }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function createEventRule(
    rule: EventTestRule
): (node: EventTest, logger: TestLogger) => TestState {
    return (node, logger) => {
        const { event } = node
        const seen = event?.count > 0
        if (!seen) logger(`event not observed`)
        return event?.count > 0 ? TestState.Pass : TestState.Fail
    }
}

function createOracleRule(
    oracle: OrableTestSpec
): (node: RegisterTest, logger: TestLogger) => TestState {
    let samples = 0
    const threshold = 5
    const { tolerance } = oracle
    return (node, logger) => {
        const { register } = node
        // find oracle register
        const oracleRegister = node.resolveOracle(register)?.register
        if (!oracleRegister) {
            logger(`oracle not found`)
            return TestState.Fail
        }

        const [oracleValue] = (oracleRegister.unpackedValue || []) as [number]
        const [value] = (register.unpackedValue || []) as [number]

        //console.log("oracle", { oracleValue, value })
        if (
            tolerance <= 0
                ? value === oracleValue
                : Math.abs(value - oracleValue) <= tolerance
        ) {
            samples++
        } else {
            samples = 0
        }

        if (samples == 0) {
            logger(`register value does not match oracle`)
            return TestState.Fail
        }
        if (samples < threshold) {
            logger(`sampling register values...`)
            return TestState.Running
        } else return TestState.Pass
    }
}

function compileTestRule(
    specification: jdspec.ServiceSpec,
    rule: ServiceTestRule
): TestNode {
    const { type } = rule
    switch (type) {
        case "reading": {
            const readingRule = rule as ReadingTestRule
            const { value, tolerance } = readingRule
            return new RegisterTest(
                `observe reading == ${value}${
                    tolerance ? ` +/-${tolerance}` : ""
                }`,
                SystemReg.Reading,
                createReadingRule(readingRule)
            )
        }
        case "event": {
            const eventRule = rule as EventTestRule
            const { name } = eventRule
            const pkt = specification.packets.find(
                pkt => isEvent(pkt) && pkt.name === name
            )
            return new EventTest(
                `raise event ${name}`,
                pkt.identifier,
                createEventRule(eventRule)
            )
        }
        default:
            return undefined
    }
}

function parseIdentifier(value: number | string) {
    if (typeof value === "string" && /^0x[0-9a-f]+$/i.test(value as string)) {
        return parseInt(value, 16)
    } else if (typeof value === "string" && /^[0-9]+$/i.test(value as string))
        return parseInt(value)
    return Number(value)
}

export function tryParsePanelTestSpec(source: string) {
    const json = JSONTryParse(source) as PanelTestSpec
    if (
        json.devices &&
        Array.isArray(json.devices) &&
        json.devices.every(d => !!d.productIdentifier && d.count > 0) &&
        (!json.oracles ||
            (Array.isArray(json.oracles) &&
                json.oracles.every(o => !!o?.serviceClass && !!o?.deviceId)))
    ) {
        for (const oracle of json.oracles || []) {
            oracle.serviceClass = parseIdentifier(oracle.serviceClass)
        }

        // normalize json
        for (const device of json.devices) {
            device.productIdentifier = parseIdentifier(device.productIdentifier)
            if (device.services) {
                for (const service of device.services) {
                    if (service.name) {
                        const spec = serviceSpecificationFromName(service.name)
                        if (!spec) {
                            console.log(`unknown service ${service.name}`)
                            return undefined
                        }
                        service.serviceClass = spec.classIdentifier
                    }
                    service.serviceClass = parseIdentifier(service.serviceClass)
                    if (!service.serviceClass) return undefined
                }
            }
        }

        return json
    }

    return undefined
}

export function createPanelTest(bus: JDBus, panel: PanelTestSpec) {
    const { id, devices = [], oracles = [] } = panel
    const { deviceCatalog } = bus
    const panelTest = new PanelTest(id, panel)
    panelTest.bus = bus

    // add oracles
    for (const oracle of oracles) {
        const { serviceClass, deviceId, serviceIndex, tolerance } = oracle
        const oracleNode = new RegisterOracle(
            `oracle for ${serviceName(serviceClass)}`,
            deviceId,
            serviceIndex,
            serviceClass,
            tolerance
        )
        panelTest.appendChild(oracleNode)
    }

    // add devices
    for (const device of devices) {
        const { productIdentifier, firmwareVersion, count } = device
        for (let i = 0; i < count; ++i) {
            const specification =
                deviceCatalog.specificationFromProductIdentifier(
                    productIdentifier
                )
            const deviceTest = new DeviceTest(productIdentifier, specification)

            // add test for control
            if (firmwareVersion) {
                const controlTest = new ServiceTest("control", SRV_CONTROL)
                controlTest.appendChild(
                    new RegisterTest(
                        `firmware version is ${firmwareVersion}`,
                        ControlReg.FirmwareVersion,
                        (node, logger) => {
                            const { register } = node
                            const ok = register?.stringValue === firmwareVersion
                            if (!ok)
                                logger(
                                    `incorrect firmware version, expected ${firmwareVersion}`
                                )
                            return ok ? TestState.Pass : TestState.Fail
                        }
                    )
                )
                deviceTest.appendChild(controlTest)
            }

            const services: ServiceTestSpec[] =
                device.services ||
                specification.services.map(srv => ({ serviceClass: srv }))

            for (const service of services) {
                const { serviceClass, count = 1, disableBuiltinRules } = service
                const serviceOracle = panel.oracles?.find(
                    oracle => oracle.serviceClass === serviceClass
                )
                const specification =
                    serviceSpecificationFromClassIdentifier(serviceClass)
                for (let i = 0; i < count; ++i) {
                    const serviceTest = new ServiceTest(
                        specification?.shortName.toLowerCase() ||
                            `0x${serviceClass.toString(16)}`,
                        serviceClass
                    )
                    {
                        // add status code
                        serviceTest.appendChild(
                            new RegisterTest(
                                "status code should be ready or sleeping",
                                BaseReg.StatusCode,
                                (node, logger) => {
                                    const { register } = node
                                    const { unpackedValue = [] } = register
                                    if (!unpackedValue.length)
                                        return TestState.Pass // not implemented
                                    const [code, vendorCode] = unpackedValue
                                    const ok =
                                        (code === SystemStatusCodes.Ready ||
                                            code ===
                                                SystemStatusCodes.Sleeping) &&
                                        vendorCode === 0
                                    if (!ok)
                                        logger(
                                            `expected status code equals to 0x0,0x0 or 0x3,0x0`
                                        )
                                    return ok ? TestState.Pass : TestState.Fail
                                }
                            )
                        )
                        // reading value rule if any
                        const readingSpec =
                            specification?.packets?.find(isReading)
                        if (readingSpec)
                            serviceTest.appendChild(
                                new RegisterTest(
                                    "reading should stream",
                                    readingSpec.identifier,
                                    node => {
                                        const { register } = node
                                        const { unpackedValue = [] } = register
                                        return unpackedValue?.length > 0
                                            ? TestState.Pass
                                            : TestState.Fail
                                    }
                                )
                            )

                        // add oracle
                        if (serviceOracle)
                            serviceTest.appendChild(
                                new RegisterTest(
                                    "reading near oracle",
                                    SystemReg.Reading,
                                    createOracleRule(serviceOracle)
                                )
                            )

                        // import additional test nodes
                        const testNodes = [
                            ...((!disableBuiltinRules &&
                                builtinTestRules[serviceClass]) ||
                                []),
                            ...(service.rules || []),
                        ]
                            .map(rule => compileTestRule(specification, rule))
                            .filter(r => !!r)
                        testNodes?.forEach(testRule =>
                            serviceTest.appendChild(testRule)
                        )

                        // import member tests
                        const testCommand =
                            builtinServiceCommandTests[serviceClass]
                        if (testCommand)
                            serviceTest.appendChild(
                                new ServiceCommandsTest(testCommand)
                            )
                    }
                    deviceTest.appendChild(serviceTest)
                }
            }
            panelTest.appendChild(deviceTest)
        }
    }
    return panelTest
}
