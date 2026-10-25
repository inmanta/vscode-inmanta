/**
 * Expand the exporting states of a csv lifecycle into the lsm states and transfers,
 * the way the LifecycleFactory of future::lsm::fsm (fsm.cf) does it.
 */
import { forEachTransfer, parseTransfer, Trigger, XState } from "./model";

export type Operation = "promote" | "rollback" | "clear candidate" | "clear rollback" | "clear active";

export interface DesiredState {
    onExport: string | null;
    onValidateSelf: string | null;
    onValidateOthers: string | null;
}

export type StateOrigin =
    | { kind: "csv"; xState: XState }
    | { kind: "validating" | "rejected"; source: string; target: string };

export interface LsmState {
    name: string;
    label: string | null;
    exportResources: boolean;
    validateSelf: string | null;
    validateOthers: string | null;
    previousAttrSetOnExport: string | null;
    previousAttrSetOnValidate: string | null;
    deleted: boolean;
    desiredState: DesiredState;
    annotations: Record<string, string>;
    origin: StateOrigin;
}

export type TransferRole = "direct" | "incoming" | "validation" | "retry" | "cancel" | "deploy";

export interface LsmTransfer {
    description: string;
    source: string;
    target: string;
    error: string | null;
    nonCompliant: string | null;
    onUpdate: boolean;
    onDelete: boolean;
    apiSetState: boolean;
    resourceBased: boolean;
    auto: boolean;
    validate: boolean;
    targetOperation: Operation | null;
    errorOperation: Operation | null;
    nonCompliantOperation: Operation | null;
    targetSameDesiredState: boolean;
    errorSameDesiredState: boolean;
    nonCompliantSameDesiredState: boolean;
    /** The csv cell this transfer comes from */
    origin: { state: string; trigger: Trigger; raw: string; role: TransferRole };
}

export interface LsmLifecycle {
    states: Map<string, LsmState>;
    transfers: LsmTransfer[];
    initialState: string | null;
    alternativeInitialStates: string[];
}

/** Port of operation() in fsm.py */
export function operation(src: LsmState, dst: LsmState): Operation | null {
    const s = [src.validateSelf, src.previousAttrSetOnExport ?? src.previousAttrSetOnValidate].join("/");
    const d = [dst.validateSelf, dst.previousAttrSetOnExport ?? dst.previousAttrSetOnValidate].join("/");
    switch (`${s}>${d}`) {
        case "candidate/active>active/rollback":
            return "promote";
        case "candidate/active>active/":
            return "clear candidate";
        case "active/candidate>active/":
            return "clear candidate";
        case "active/rollback>active/":
            return "clear rollback";
        case "active/rollback>active/candidate":
            return "rollback";
        case "active/candidate>active/rollback":
            return "promote";
        default:
            return null;
    }
}

/** Port of same_desired_state() in fsm.py */
export function sameDesiredState(src: LsmState, dst: LsmState, op: Operation | null): boolean {
    if (op === "promote" || op === "clear rollback" || op === "rollback") {
        return false;
    }
    return src.desiredState.onExport === dst.desiredState.onExport;
}

/** Port of validation_annotations() in fsm.py */
function validationAnnotations(source: XState, target: XState, rejected: boolean): Record<string, string> {
    const src = source.annotations.web_label ?? source.name;
    const tgt = target.annotations.web_label ?? target.name;
    if (rejected) {
        return {
            ...target.annotations,
            web_label: `Rejected ${tgt}`,
            web_icon: "FaBan",
            web_description:
                `The validation of the transition from ${src} to ${tgt} failed.  ` +
                `${src} remains enforced until the validation is retried and passes, or the change is cancelled.`,
        };
    }
    return {
        ...target.annotations,
        web_label: `Validating ${tgt}`,
        web_icon: "FaClipboardCheck",
        web_description: `Validating the transition from ${src} to ${tgt}.  ${src} remains enforced until the validation passes.`,
    };
}

export class ExpansionError extends Error {}

function blankTransfer(origin: LsmTransfer["origin"], description: string, source: string): LsmTransfer {
    return {
        description,
        source,
        target: "",
        error: null,
        nonCompliant: null,
        onUpdate: false,
        onDelete: false,
        apiSetState: false,
        resourceBased: false,
        auto: false,
        validate: false,
        targetOperation: null,
        errorOperation: null,
        nonCompliantOperation: null,
        targetSameDesiredState: false,
        errorSameDesiredState: false,
        nonCompliantSameDesiredState: false,
        origin,
    };
}

/**
 * Build the lsm lifecycle.  Transfers whose expression or target is invalid are skipped,
 * the checks report them.
 */
export function expand(xStates: readonly XState[]): LsmLifecycle {
    const states = new Map<string, LsmState>();
    const transfers: LsmTransfer[] = [];
    const byName = new Map(xStates.map((x) => [x.name, x]));

    for (const x of xStates) {
        if (states.has(x.name)) {
            continue;
        }
        states.set(x.name, {
            name: x.name,
            label: x.label,
            exportResources: x.triggers.on_deployed.length > 0,
            validateSelf: x.current,
            validateOthers: x.current,
            previousAttrSetOnExport: x.previous,
            previousAttrSetOnValidate: null,
            deleted: x.current === null && x.triggers.on_create.length === 0,
            desiredState: { onExport: x.desiredState, onValidateSelf: null, onValidateOthers: x.desiredState },
            annotations: x.annotations,
            origin: { kind: "csv", xState: x },
        });
    }

    const lookup = (name: string | undefined): LsmState | undefined => (name === undefined ? undefined : states.get(name));

    function validation(
        incoming: LsmTransfer,
        incomingRollback: boolean,
        target: LsmState,
        escape: LsmState | undefined,
        targetOperation: Operation | null,
    ): void {
        const source = states.get(incoming.source)!;
        const sourceX = byName.get(source.name)!;
        const targetX = byName.get(target.name)!;
        const origin = incoming.origin;

        const validatingName = `validating_${target.name}_from_${source.name}`;
        const rejectedName = `rejected_${target.name}_from_${source.name}`;
        incoming.target = validatingName;
        if (states.has(validatingName)) {
            // fsm.cf would fail on the duplicate index, keep the first one
            return;
        }

        const validating: LsmState = {
            name: validatingName,
            label: null,
            exportResources: source.exportResources,
            validateSelf: targetOperation === "promote" ? "candidate" : targetOperation === "rollback" ? "rollback" : "active",
            validateOthers: source.exportResources ? "active" : null,
            previousAttrSetOnExport: source.previousAttrSetOnExport,
            previousAttrSetOnValidate: target.previousAttrSetOnExport !== null ? "active" : null,
            deleted: false,
            annotations: validationAnnotations(sourceX, targetX, false),
            desiredState: {
                onExport: source.desiredState.onExport,
                onValidateSelf: target.desiredState.onExport,
                onValidateOthers: source.desiredState.onExport,
            },
            origin: { kind: "validating", source: source.name, target: target.name },
        };
        const rejected: LsmState = {
            name: rejectedName,
            label: "warning",
            exportResources: source.exportResources,
            validateSelf: source.validateSelf,
            validateOthers: source.validateOthers,
            previousAttrSetOnExport: source.previousAttrSetOnExport,
            previousAttrSetOnValidate: source.previousAttrSetOnValidate,
            deleted: false,
            annotations: validationAnnotations(sourceX, targetX, true),
            desiredState: source.desiredState,
            origin: { kind: "rejected", source: source.name, target: target.name },
        };
        states.set(validatingName, validating);
        states.set(rejectedName, rejected);

        // The flags of the incoming transfer are resolved against the validating state
        if (!incomingRollback) {
            incoming.targetOperation = operation(source, validating);
        }
        incoming.targetSameDesiredState = sameDesiredState(source, validating, incoming.targetOperation);

        transfers.push({
            ...blankTransfer({ ...origin, role: "validation" }, `Validation transfer from ${source.name} to ${target.name}`, validatingName),
            target: target.name,
            error: rejectedName,
            validate: true,
            auto: true,
            targetSameDesiredState: false,
            errorSameDesiredState: true,
            targetOperation,
        });

        const promote = targetOperation === "promote";
        transfers.push({
            ...blankTransfer({ ...origin, role: "retry" }, `Retry validation from ${source.name} to ${target.name}`, rejectedName),
            target: validatingName,
            onUpdate: promote,
            apiSetState: incoming.apiSetState || (incoming.auto && !promote),
            onDelete: incoming.onDelete,
            targetSameDesiredState: true,
        });

        const cancelTarget = escape ?? source;
        const cancelOperation: Operation | null = promote && source.exportResources ? "clear candidate" : null;
        transfers.push({
            ...blankTransfer({ ...origin, role: "cancel" }, `Cancel validation from ${source.name} to ${target.name}`, rejectedName),
            target: cancelTarget.name,
            apiSetState: true,
            targetOperation: cancelOperation,
            targetSameDesiredState: sameDesiredState(rejected, cancelTarget, cancelOperation),
        });

        for (const s of [validating, rejected]) {
            if (s.exportResources) {
                transfers.push({
                    ...blankTransfer({ ...origin, role: "deploy" }, `Deploying ${s.name}`, s.name),
                    target: s.name,
                    error: s.name,
                    resourceBased: true,
                    targetSameDesiredState: true,
                    errorSameDesiredState: true,
                });
            }
        }
    }

    for (const x of xStates) {
        const state = states.get(x.name)!;
        if (state.origin.kind !== "csv" || state.origin.xState !== x) {
            continue;
        }

        const deployed = x.triggers.on_deployed[0];
        if (deployed !== undefined) {
            const target = lookup(parseTarget(deployed));
            const error = lookup(parseTarget(x.triggers.on_failed[0]));
            const nonCompliant = lookup(parseTarget(x.triggers.on_non_compliant[0]));
            if (target !== undefined && error !== undefined) {
                const t = blankTransfer({ state: x.name, trigger: "on_deployed", raw: deployed, role: "direct" }, `Deploying ${x.name}`, x.name);
                t.target = target.name;
                t.error = error.name;
                t.resourceBased = true;
                t.targetOperation = operation(state, target);
                t.errorOperation = operation(state, error);
                t.targetSameDesiredState = sameDesiredState(state, target, t.targetOperation);
                t.errorSameDesiredState = sameDesiredState(state, error, t.errorOperation);
                if (nonCompliant !== undefined) {
                    t.nonCompliant = nonCompliant.name;
                    t.nonCompliantOperation = operation(state, nonCompliant);
                    t.nonCompliantSameDesiredState = sameDesiredState(state, nonCompliant, t.nonCompliantOperation);
                }
                transfers.push(t);
            }
        }

        forEachTransfer(x, (trigger, raw, expr) => {
            if (expr === null || ["on_deployed", "on_failed", "on_non_compliant"].includes(trigger)) {
                return;
            }
            const target = lookup(expr.target);
            const escape = expr.escape === null ? undefined : lookup(expr.escape);
            if (target === undefined || (expr.escape !== null && escape === undefined)) {
                return;
            }
            const descriptions: Record<string, string> = {
                on_create: `Create in ${x.name}`,
                on_update: `Updating from ${x.name}`,
                on_auto: `Auto transfer to ${x.name}`,
                on_delete: `Deleting from ${x.name}`,
                on_api_set_state: `Set ${expr.target} from ${x.name}`,
            };
            const t = blankTransfer({ state: x.name, trigger, raw, role: expr.validate ? "incoming" : "direct" }, descriptions[trigger], x.name);
            t.auto = trigger === "on_create" || trigger === "on_auto";
            t.onUpdate = trigger === "on_update";
            t.onDelete = trigger === "on_delete";
            t.apiSetState = trigger === "on_api_set_state";
            // on_create and on_update ignore the rollback() wrapper, the others apply the rollback operation
            const rollback = expr.rollback && !["on_create", "on_update"].includes(trigger);
            if (rollback) {
                t.targetOperation = "rollback";
            }
            transfers.push(t);

            if (expr.validate) {
                const validationOperation: Operation | null =
                    trigger === "on_create" || trigger === "on_update" ? "promote" : expr.rollback ? "rollback" : null;
                validation(t, rollback, target, escape, validationOperation);
            } else {
                t.target = target.name;
                if (!rollback) {
                    t.targetOperation = operation(state, target);
                }
                t.targetSameDesiredState = sameDesiredState(state, target, t.targetOperation);
            }
        });
    }

    const initial = xStates.filter((x) => x.triggers.on_create.length > 0).map((x) => x.name);
    return {
        states,
        transfers,
        initialState: initial[0] ?? null,
        alternativeInitialStates: [...new Set(initial.slice(1))],
    };
}

function parseTarget(raw: string | undefined): string | undefined {
    return raw === undefined ? undefined : parseTransfer(raw)?.target;
}

/**
 * The one letter code lsm uses for a transfer (LifecycleTransfer.short_code).
 */
export function shortCode(t: LsmTransfer): string {
    let code: string;
    if (t.apiSetState) {
        code = "S";
    } else if (t.onUpdate) {
        code = "U";
    } else if (t.onDelete) {
        code = "D";
    } else if (t.resourceBased) {
        code = "R";
    } else {
        code = "A";
    }
    return t.validate ? code + "V" : code;
}
