/**
 * Checks on a csv lifecycle.  Errors are problems that make the compile fail, warnings are
 * lifecycles that compile but are most likely not what was intended.
 */
import { ANNOTATION_KEYS } from "./annotations";
import { expand, LsmLifecycle } from "./expand";
import { forEachTransfer, isAnnotation, LABELS, LifecycleFile, StatesFile, XState } from "./model";

export type Severity = "error" | "warning" | "info";

export interface Issue {
    severity: Severity;
    code: string;
    message: string;
    /** The state the issue is about, if any */
    state?: string;
    /** Zero-based line in the lifecycle csv */
    line?: number;
    /** The column of the lifecycle csv the issue is about */
    column?: string;
    /** Set when the issue is located in the states csv instead */
    inStatesFile?: boolean;
}

const KNOWN_WEB_KEYS = new Set(ANNOTATION_KEYS.map((a) => a.key));

export function lint(lifecycle: LifecycleFile, states?: StatesFile, expanded?: LsmLifecycle): Issue[] {
    const issues: Issue[] = [];
    const xs = lifecycle.states;
    const byName = new Map<string, XState>();
    const header = lifecycle.table.header.values;
    const at = (x: XState, column?: string) => ({ state: x.name, line: x.line, column });

    for (const required of ["name", "desired_state"]) {
        if (!header.includes(required)) {
            issues.push({ severity: "error", code: "missing-column", message: `The lifecycle csv has no ${required} column`, line: 0 });
        }
    }
    for (const column of header) {
        if (isAnnotation(column) && column.startsWith("web_") && !KNOWN_WEB_KEYS.has(column)) {
            issues.push({ severity: "info", code: "unknown-annotation", message: `${column} is not a known web_* annotation, is it a typo?`, line: 0, column });
        }
    }

    for (const x of xs) {
        if (!x.name) {
            issues.push({ severity: "error", code: "missing-name", message: "State without a name", ...at(x, "name") });
            continue;
        }
        if (!/^[a-z_]+$/.test(x.name)) {
            issues.push({
                severity: "warning",
                code: "unreachable-name",
                message: `${x.name} can't be the target of a transfer, transfer expressions only accept lowercase letters and underscores`,
                ...at(x, "name"),
            });
        }
        if (byName.has(x.name)) {
            issues.push({ severity: "error", code: "duplicate-state", message: `Duplicate state ${x.name}`, ...at(x, "name") });
        } else {
            byName.set(x.name, x);
        }
        if (!x.desiredState) {
            issues.push({ severity: "error", code: "missing-desired-state", message: `${x.name} has no desired_state`, ...at(x, "desired_state") });
        }
        if (x.label !== null && !(LABELS as readonly string[]).includes(x.label)) {
            issues.push({ severity: "info", code: "unknown-label", message: `Label ${x.label} is not one of ${LABELS.join(", ")}`, ...at(x, "label") });
        }
        if (x.previous !== null && x.current === null) {
            issues.push({ severity: "warning", code: "previous-without-current", message: `${x.name} has a previous attribute set but no current one`, ...at(x, "previous") });
        }
        if (x.triggers.on_deployed.length > 0 && x.triggers.on_failed.length === 0) {
            issues.push({ severity: "error", code: "deployed-without-failed", message: `${x.name} has on_deployed without on_failed, the factory requires both`, ...at(x, "on_failed") });
        }
        if (x.triggers.on_deployed.length === 0) {
            for (const trigger of ["on_failed", "on_non_compliant"] as const) {
                if (x.triggers[trigger].length > 0) {
                    issues.push({ severity: "warning", code: "ignored-trigger", message: `${trigger} is ignored without on_deployed`, ...at(x, trigger) });
                }
            }
        }
    }

    for (const x of xs) {
        if (!x.name) {
            continue;
        }
        forEachTransfer(x, (trigger, raw, expr) => {
            if (expr === null) {
                const hint = raw !== raw.trim() ? " (remove the surrounding spaces)" : trigger === "on_api_set_state" && raw.includes("(") && !raw.includes(")") ? " (on_api_set_state is split on every comma, so validate(target, escape) can't be used here)" : "";
                issues.push({ severity: "error", code: "invalid-transfer", message: `Invalid transfer expression '${raw}'${hint}`, ...at(x, trigger) });
                return;
            }
            for (const name of [expr.target, expr.escape]) {
                if (name !== null && !byName.has(name)) {
                    issues.push({ severity: "error", code: "unknown-state", message: `Unknown state ${name} in ${trigger}`, ...at(x, trigger) });
                }
            }
            if (["on_deployed", "on_failed", "on_non_compliant"].includes(trigger) && (expr.validate || expr.rollback)) {
                issues.push({ severity: "warning", code: "ignored-wrapper", message: `validate() and rollback() are ignored in ${trigger}`, ...at(x, trigger) });
            }
            if (["on_create", "on_update"].includes(trigger) && expr.rollback) {
                issues.push({ severity: "warning", code: "ignored-wrapper", message: `rollback() is ignored in ${trigger}`, ...at(x, trigger) });
            }
        });
    }

    if (!xs.some((x) => x.triggers.on_create.length > 0)) {
        issues.push({ severity: "error", code: "no-initial-state", message: "No state has an on_create transfer, the lifecycle has no initial state", line: 0 });
    }

    if (states !== undefined) {
        const desired = new Set(states.options.map((o) => o.name));
        for (const x of xs) {
            if (x.desiredState && !desired.has(x.desiredState)) {
                issues.push({ severity: "error", code: "unknown-desired-state", message: `Desired state ${x.desiredState} is not defined in the states csv`, ...at(x, "desired_state") });
            }
        }
        for (const o of states.options) {
            for (const [column, value] of [["created_child", o.createdChild], ["removed_child", o.removedChild]] as const) {
                if (value !== null && !desired.has(value)) {
                    issues.push({ severity: "error", code: "unknown-desired-state", message: `${column} of ${o.name} names unknown desired state ${value}`, line: o.line, column, inStatesFile: true });
                }
            }
        }
    }

    // desired_state_properties only looks at the first state of a desired state to decide whether
    // it exports and whether it is updating
    const firstByDesired = new Map<string, XState>();
    for (const x of xs) {
        const first = firstByDesired.get(x.desiredState);
        if (first === undefined) {
            firstByDesired.set(x.desiredState, x);
        } else if ((first.current === null) !== (x.current === null) || (first.previous === null) !== (x.previous === null)) {
            issues.push({
                severity: "warning",
                code: "inconsistent-desired-state",
                message: `${x.name} and ${first.name} share desired state ${x.desiredState} but only one of them has a current or previous attribute set`,
                ...at(x, "previous"),
            });
        }
    }

    // Graph checks on the expanded lifecycle
    const lsm = expanded ?? expand(xs);
    const outgoing = new Map<string, string[]>();
    for (const t of lsm.transfers) {
        for (const target of [t.target, t.error, t.nonCompliant]) {
            if (target !== null && target !== t.source) {
                outgoing.set(t.source, [...(outgoing.get(t.source) ?? []), target]);
            }
        }
    }
    const reachable = new Set<string>();
    const todo = [lsm.initialState, ...lsm.alternativeInitialStates].filter((s): s is string => s !== null);
    while (todo.length > 0) {
        const s = todo.pop()!;
        if (!reachable.has(s)) {
            reachable.add(s);
            todo.push(...(outgoing.get(s) ?? []));
        }
    }
    for (const x of xs) {
        if (!byName.has(x.name) || byName.get(x.name) !== x) {
            continue;
        }
        const state = lsm.states.get(x.name)!;
        if (lsm.initialState !== null && !reachable.has(x.name)) {
            issues.push({ severity: "warning", code: "unreachable", message: `${x.name} can't be reached from any initial state`, ...at(x, "name") });
        }
        if (!state.deleted && (outgoing.get(x.name) ?? []).length === 0) {
            issues.push({ severity: "warning", code: "dead-end", message: `${x.name} is not a deleted state but has no way out`, ...at(x, "name") });
        }
        if (x.label === "danger") {
            const exits = lsm.transfers.filter((t) => t.source === x.name && (t.apiSetState || t.onUpdate || t.onDelete) && t.target !== x.name);
            if (exits.length === 0) {
                issues.push({ severity: "warning", code: "no-operator-exit", message: `Failure state ${x.name} only leaves when its resources deploy, an operator can't update, delete or set its state`, ...at(x, "name") });
            }
        }
    }

    return issues;
}
