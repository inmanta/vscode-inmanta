/**
 * Simulate a service instance going through an lsm lifecycle.  The attribute sets are
 * tracked as version numbers, the operations are applied the way inmanta-lsm applies them.
 */
import { LsmLifecycle, LsmState, LsmTransfer, Operation } from "./expand";

export interface AttributeSets {
    candidate: number | null;
    active: number | null;
    rollback: number | null;
}

export interface Instance {
    state: string;
    /** Version of the instance, bumped on every transfer and attribute change */
    version: number;
    sets: AttributeSets;
    /** Version of the next attribute set created by an update */
    nextAttributes: number;
}

export type SimEvent =
    | { kind: "create"; state?: string }
    | { kind: "update" }
    | { kind: "delete" }
    | { kind: "set_state"; target: string }
    | { kind: "validation"; ok: boolean }
    | { kind: "resources"; outcome: "deployed" | "failed" | "non_compliant" };

export interface Hop {
    transfer: LsmTransfer;
    from: string;
    to: string;
    outcome: "target" | "error" | "non_compliant";
    operation: Operation | null;
    /** Whether lsm keeps the desired state, when false an exporting compile follows */
    sameDesiredState: boolean;
}

export interface Step {
    event: SimEvent;
    hops: Hop[];
    instance: Instance;
    /** Set when the event is not accepted in the current state */
    rejected?: string;
    /** Set when the instance stays where it is, e.g. a resource outcome without transfer */
    note?: string;
}

export interface EventOption {
    event: SimEvent;
    label: string;
    enabled: boolean;
    /** Why the event is not accepted, or where it leads */
    detail: string;
}

const MAX_AUTO_HOPS = 100;

export function applyOperation(sets: AttributeSets, op: Operation | null): AttributeSets {
    switch (op) {
        case "promote":
            return { candidate: null, active: sets.candidate, rollback: sets.active };
        case "rollback":
            return { candidate: sets.active, active: sets.rollback, rollback: null };
        case "clear candidate":
            return { ...sets, candidate: null };
        case "clear rollback":
            return { ...sets, rollback: null };
        case "clear active":
            return { ...sets, active: null };
        default:
            return sets;
    }
}

export function eventLabel(event: SimEvent): string {
    switch (event.kind) {
        case "create":
            return event.state ? `create in ${event.state}` : "create";
        case "update":
            return "update";
        case "delete":
            return "delete";
        case "set_state":
            return `set state ${event.target}`;
        case "validation":
            return event.ok ? "validation ok" : "validation failed";
        case "resources":
            return event.outcome === "non_compliant" ? "non-compliant" : event.outcome;
    }
}

/**
 * Parse the step notation used in scenarios: create, create:state, update, delete,
 * set_state:target, validation_ok, validation_failed, deployed, failed, non_compliant.
 */
export function parseEvent(raw: string): SimEvent | null {
    const [kind, arg] = raw.trim().split(":").map((s) => s.trim());
    switch (kind) {
        case "create":
            return arg ? { kind, state: arg } : { kind };
        case "update":
        case "delete":
            return { kind };
        case "set_state":
            return arg ? { kind, target: arg } : null;
        case "validation_ok":
            return { kind: "validation", ok: true };
        case "validation_failed":
            return { kind: "validation", ok: false };
        case "deployed":
        case "failed":
        case "non_compliant":
            return { kind: "resources", outcome: kind };
        default:
            return null;
    }
}

export function formatEvent(event: SimEvent): string {
    switch (event.kind) {
        case "create":
            return event.state ? `create:${event.state}` : "create";
        case "set_state":
            return `set_state:${event.target}`;
        case "validation":
            return event.ok ? "validation_ok" : "validation_failed";
        case "resources":
            return event.outcome;
        default:
            return event.kind;
    }
}

export class Simulator {
    constructor(private readonly lifecycle: LsmLifecycle) {}

    private outgoing(state: string): LsmTransfer[] {
        return this.lifecycle.transfers.filter((t) => t.source === state);
    }

    state(name: string): LsmState | undefined {
        return this.lifecycle.states.get(name);
    }

    /**
     * An instance put directly in a state, with the attribute sets that state expects.
     */
    instanceIn(name: string): Instance {
        const state = this.lifecycle.states.get(name);
        const uses = [state?.validateSelf, state?.validateOthers, state?.previousAttrSetOnExport, state?.previousAttrSetOnValidate];
        return {
            state: name,
            version: 1,
            sets: {
                rollback: uses.includes("rollback") ? 1 : null,
                active: state?.validateSelf || state?.validateOthers ? 2 : null,
                candidate: uses.includes("candidate") ? 3 : null,
            },
            nextAttributes: 4,
        };
    }

    options(instance: Instance | null): EventOption[] {
        if (instance === null) {
            const initial = [this.lifecycle.initialState, ...this.lifecycle.alternativeInitialStates].filter((s): s is string => s !== null);
            return initial.map((s, i) => ({
                event: i === 0 ? { kind: "create" } : { kind: "create", state: s },
                label: i === 0 ? "Create" : `Create in ${s}`,
                enabled: true,
                detail: `starts in ${s}`,
            }));
        }
        const out = this.outgoing(instance.state);
        const find = (predicate: (t: LsmTransfer) => boolean) => out.find(predicate);
        const result: EventOption[] = [];

        const update = find((t) => t.onUpdate);
        result.push({ event: { kind: "update" }, label: "Update", enabled: !!update, detail: update ? `→ ${update.target}` : "no on_update transfer, the api rejects it" });
        const del = find((t) => t.onDelete);
        result.push({ event: { kind: "delete" }, label: "Delete", enabled: !!del, detail: del ? `→ ${del.target}` : "no on_delete transfer, the api rejects it" });
        for (const t of out.filter((t) => t.apiSetState)) {
            result.push({
                event: { kind: "set_state", target: t.target },
                label: `Set state ${t.target}`,
                enabled: true,
                detail: t.targetOperation ? `${t.origin.role} · ${t.targetOperation}` : t.origin.role,
            });
        }
        const validation = find((t) => t.validate && t.auto);
        if (validation) {
            result.push({ event: { kind: "validation", ok: true }, label: "Validation passes", enabled: true, detail: `→ ${validation.target}` });
            result.push({ event: { kind: "validation", ok: false }, label: "Validation fails", enabled: true, detail: `→ ${validation.error}` });
        }
        const deploy = find((t) => t.resourceBased);
        result.push({ event: { kind: "resources", outcome: "deployed" }, label: "Resources deployed", enabled: !!deploy, detail: deploy ? `→ ${deploy.target}` : "the state doesn't export resources" });
        result.push({ event: { kind: "resources", outcome: "failed" }, label: "Resources failed", enabled: !!deploy, detail: deploy ? `→ ${deploy.error}` : "the state doesn't export resources" });
        result.push({
            event: { kind: "resources", outcome: "non_compliant" },
            label: "Resources non-compliant",
            enabled: !!deploy?.nonCompliant,
            detail: deploy ? (deploy.nonCompliant ? `→ ${deploy.nonCompliant}` : "no on_non_compliant transfer") : "the state doesn't export resources",
        });
        return result;
    }

    private hop(instance: Instance, transfer: LsmTransfer, outcome: Hop["outcome"]): [Instance, Hop] {
        const to = outcome === "target" ? transfer.target : outcome === "error" ? transfer.error! : transfer.nonCompliant!;
        const operation =
            outcome === "target" ? transfer.targetOperation : outcome === "error" ? transfer.errorOperation : transfer.nonCompliantOperation;
        const same =
            outcome === "target"
                ? transfer.targetSameDesiredState
                : outcome === "error"
                  ? transfer.errorSameDesiredState
                  : transfer.nonCompliantSameDesiredState;
        const next: Instance = { ...instance, state: to, version: instance.version + 1, sets: applyOperation(instance.sets, operation) };
        return [next, { transfer, from: instance.state, to, outcome, operation, sameDesiredState: same }];
    }

    /**
     * Follow the auto transfers without validation, the ones lsm takes without any input.
     */
    private settle(instance: Instance, hops: Hop[]): Instance {
        for (let i = 0; i < MAX_AUTO_HOPS; i++) {
            const auto = this.outgoing(instance.state).find((t) => t.auto && !t.validate);
            if (auto === undefined) {
                return instance;
            }
            const [next, hop] = this.hop(instance, auto, "target");
            hops.push(hop);
            instance = next;
        }
        return instance;
    }

    apply(instance: Instance | null, event: SimEvent): Step {
        const hops: Hop[] = [];
        const reject = (reason: string): Step => ({ event, hops, instance: instance!, rejected: reason });

        if (event.kind === "create") {
            if (instance !== null) {
                return reject("the instance already exists");
            }
            const initial = [this.lifecycle.initialState, ...this.lifecycle.alternativeInitialStates];
            const state = event.state ?? this.lifecycle.initialState;
            if (state === null || state === undefined || !initial.includes(state)) {
                return { event, hops, instance: this.instanceIn(state ?? ""), rejected: `${state} is not an initial state` };
            }
            const created: Instance = { state, version: 1, sets: { candidate: 1, active: null, rollback: null }, nextAttributes: 2 };
            return { event, hops, instance: this.settle(created, hops) };
        }
        if (instance === null) {
            return { event, hops, instance: this.instanceIn(""), rejected: "create the instance first" };
        }

        const out = this.outgoing(instance.state);
        let transfer: LsmTransfer | undefined;
        let outcome: Hop["outcome"] = "target";
        let current = instance;

        switch (event.kind) {
            case "update":
                transfer = out.find((t) => t.onUpdate);
                if (!transfer) {
                    return reject(`${instance.state} has no on_update transfer`);
                }
                current = { ...current, sets: { ...current.sets, candidate: current.nextAttributes }, nextAttributes: current.nextAttributes + 1 };
                break;
            case "delete":
                transfer = out.find((t) => t.onDelete);
                if (!transfer) {
                    return reject(`${instance.state} has no on_delete transfer`);
                }
                break;
            case "set_state":
                transfer = out.find((t) => t.apiSetState && t.target === event.target);
                if (!transfer) {
                    return reject(`${instance.state} has no api_set_state transfer to ${event.target}`);
                }
                break;
            case "validation":
                transfer = out.find((t) => t.validate && t.auto);
                if (!transfer) {
                    return reject(`${instance.state} is not validating`);
                }
                outcome = event.ok ? "target" : "error";
                break;
            case "resources":
                transfer = out.find((t) => t.resourceBased);
                if (!transfer) {
                    return reject(`${instance.state} doesn't export resources`);
                }
                outcome = event.outcome === "deployed" ? "target" : event.outcome === "failed" ? "error" : "non_compliant";
                if (outcome === "non_compliant" && transfer.nonCompliant === null) {
                    return { event, hops, instance, note: `${instance.state} has no on_non_compliant transfer, the instance stays` };
                }
                break;
        }

        const [next, hop] = this.hop(current, transfer, outcome);
        hops.push(hop);
        return { event, hops, instance: this.settle(next, hops) };
    }
}

export interface ScenarioResult {
    steps: Step[];
    finalState: string | null;
    passed: boolean;
    failure?: string;
}

/**
 * Run a scenario: an optional start state, a list of events and the expected final state.
 */
export function runScenario(lifecycle: LsmLifecycle, scenario: { start?: string; steps: readonly string[]; expect?: string }): ScenarioResult {
    const sim = new Simulator(lifecycle);
    let instance: Instance | null = scenario.start ? sim.instanceIn(scenario.start) : null;
    if (scenario.start && !lifecycle.states.has(scenario.start)) {
        return { steps: [], finalState: null, passed: false, failure: `Unknown start state ${scenario.start}` };
    }
    const steps: Step[] = [];
    for (const raw of scenario.steps) {
        const event = parseEvent(raw);
        if (event === null) {
            return { steps, finalState: instance?.state ?? null, passed: false, failure: `Unknown step '${raw}'` };
        }
        const step = sim.apply(instance, event);
        steps.push(step);
        if (step.rejected) {
            return { steps, finalState: instance?.state ?? null, passed: false, failure: `Step '${raw}' rejected: ${step.rejected}` };
        }
        instance = step.instance;
    }
    const finalState = instance?.state ?? null;
    if (scenario.expect !== undefined && finalState !== scenario.expect) {
        return { steps, finalState, passed: false, failure: `Ended in ${finalState}, expected ${scenario.expect}` };
    }
    return { steps, finalState, passed: true };
}

export interface CompileContext {
    kind: "export" | "validate_self" | "validate_others";
    title: string;
    /** The desired state the model sees, null when the compile fails for this instance */
    desiredState: string | null;
    /** The attribute set the instance is compiled with, null when the instance is not part of the compile */
    attributes: string | null;
    previous: string | null;
}

/**
 * What the model sees of an instance in this state, for each kind of compile.  Mirrors
 * get_service_desired_state in fsm.py.
 */
export function compileContexts(state: LsmState): CompileContext[] {
    return [
        {
            kind: "export",
            title: "Export",
            desiredState: state.desiredState.onExport,
            attributes: state.validateSelf !== null || state.exportResources ? "active" : null,
            previous: state.previousAttrSetOnExport,
        },
        {
            kind: "validate_self",
            title: "Validate self",
            desiredState: state.desiredState.onValidateSelf,
            attributes: state.validateSelf,
            previous: state.previousAttrSetOnValidate ?? state.previousAttrSetOnExport,
        },
        {
            kind: "validate_others",
            title: "Validate other",
            desiredState: state.desiredState.onValidateOthers,
            attributes: state.validateOthers,
            previous: state.previousAttrSetOnExport,
        },
    ];
}
