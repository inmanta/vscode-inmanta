/**
 * Changes to the stages of a lifecycle.  The stage of a state is its web_stage annotation, set
 * in the lifecycle csv or for its desired state in the states csv, and defaults to its desired
 * state.  The stages csv holds the names and order of the stages.
 */
import { EditOp } from "./edit";
import { stageOf } from "./graph";
import { MetadataOp } from "./metadata";
import { LifecycleFile, StatesFile, XState } from "./model";

export interface StageChange {
    csv: EditOp[];
    states: EditOp[];
    metadata: MetadataOp[];
}

export class StageError extends Error {}

const STAGE_ID = /^[A-Za-z0-9_-]+$/;

/** The stage of a state when its own web_stage cell is empty */
function defaultStage(x: XState, states: StatesFile | undefined): string {
    const inherited = states?.options.find((o) => o.name === x.desiredState)?.annotations.web_stage;
    return inherited ?? (x.current === null ? "" : x.desiredState);
}

function stageIds(lifecycle: LifecycleFile): Set<string> {
    return new Set(lifecycle.states.map(stageOf).filter((id) => id !== ""));
}

/** Put a state in a stage, the state gets laid out again in its new stage */
export function moveToStage(lifecycle: LifecycleFile, states: StatesFile | undefined, name: string, stage: string): StageChange {
    const x = lifecycle.states.find((s) => s.name === name);
    if (x === undefined) {
        throw new StageError(`No state named ${name}`);
    }
    const value = stage === defaultStage(x, states) ? "" : stage;
    return {
        csv: (x.ownAnnotations.web_stage ?? "") === value ? [] : [{ kind: "setCell", state: name, column: "web_stage", value }],
        states: [],
        metadata: [{ kind: "removeLayout", states: [name] }],
    };
}

/** Rename a stage everywhere it is set, a stage that defaults to a desired state gets set on its states */
export function renameStage(
    lifecycle: LifecycleFile,
    states: StatesFile | undefined,
    declared: readonly { id: string }[],
    from: string,
    to: string,
): StageChange {
    if (!STAGE_ID.test(to)) {
        throw new StageError("A stage id can only hold letters, digits, underscores and dashes");
    }
    if (to !== from && (stageIds(lifecycle).has(to) || declared.some((s) => s.id === to))) {
        throw new StageError(`Stage ${to} already exists`);
    }
    const change: StageChange = { csv: [], states: [], metadata: [{ kind: "renameStage", from, to }] };
    for (const option of states?.options ?? []) {
        if (option.annotations.web_stage === from) {
            change.states.push({ kind: "setCell", state: option.name, column: "web_stage", value: to });
        }
    }
    for (const x of lifecycle.states) {
        const own = x.ownAnnotations.web_stage;
        const inherited = !own && x.annotations.web_stage !== undefined;
        if (stageOf(x) === from && !inherited) {
            change.csv.push({ kind: "setCell", state: x.name, column: "web_stage", value: to });
        }
    }
    return change;
}

/** Drop a stage, its states go back to their default stage */
export function deleteStage(lifecycle: LifecycleFile, states: StatesFile | undefined, id: string): StageChange {
    return {
        csv: lifecycle.states
            .filter((x) => x.ownAnnotations.web_stage === id)
            .map((x): EditOp => ({ kind: "setCell", state: x.name, column: "web_stage", value: "" })),
        states: (states?.options ?? [])
            .filter((o) => o.annotations.web_stage === id)
            .map((o): EditOp => ({ kind: "setCell", state: o.name, column: "web_stage", value: "" })),
        metadata: [{ kind: "deleteStage", id }],
    };
}

/** Declare a new, empty stage */
export function addStage(lifecycle: LifecycleFile, declared: readonly { id: string }[], id: string, name: string): StageChange {
    if (!STAGE_ID.test(id)) {
        throw new StageError("A stage id can only hold letters, digits, underscores and dashes");
    }
    if (stageIds(lifecycle).has(id) || declared.some((s) => s.id === id)) {
        throw new StageError(`Stage ${id} already exists`);
    }
    return { csv: [], states: [], metadata: [{ kind: "upsertStage", stage: { id, name } }] };
}
