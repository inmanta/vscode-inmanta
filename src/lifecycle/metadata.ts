/**
 * The metadata file of a lifecycle (<name>.lifecycle.yml next to the lifecycle csv): what the
 * csv can't hold, such as stage definitions, transfer annotations, layout and test scenarios.
 */
import { Document, isMap, isSeq, parseDocument } from "yaml";
import { parseTransfer, Trigger, XState } from "./model";
import { formatEvent, parseEvent } from "./simulator";

export interface StageDefinition {
    id: string;
    name?: string;
    column?: number;
    row?: number;
    description?: string;
}

export interface TransferAnnotations {
    source: string;
    trigger: Trigger;
    target: string;
    annotations: Record<string, string | boolean>;
}

export interface Scenario {
    name: string;
    start?: string;
    steps: string[];
    expect?: string;
}

export interface Metadata {
    statesCsv?: string;
    lifecycle: Record<string, string>;
    stages: StageDefinition[];
    transfers: TransferAnnotations[];
    layout: Record<string, { x: number; y: number }>;
    scenarios: Scenario[];
}

/** The triggers whose transfers the lifecycle factory annotates */
export const TRANSFER_ANNOTATION_TRIGGERS: readonly Trigger[] = ["on_create", "on_update", "on_delete", "on_api_set_state", "on_auto", "on_deployed"];

/** The transfer entries the lifecycle factory rejects: they must match a transfer of the csv */
export function metadataIssues(metadata: Metadata, states: readonly XState[]): string[] {
    return metadata.transfers.flatMap((entry) => {
        const where = `transfer ${entry.source}.${entry.trigger} -> ${entry.target}`;
        const state = states.find((x) => x.name === entry.source);
        if (state === undefined) {
            return [`${where}: no state ${entry.source}`];
        }
        if (!TRANSFER_ANNOTATION_TRIGGERS.includes(entry.trigger)) {
            return [`${where}: the factory doesn't annotate ${entry.trigger} transfers`];
        }
        return state.triggers[entry.trigger].some((raw) => parseTransfer(raw)?.target === entry.target) ? [] : [`${where}: ${entry.source} has no such transfer`];
    });
}

export function emptyMetadata(): Metadata {
    return { lifecycle: {}, stages: [], transfers: [], layout: {}, scenarios: [] };
}

/** The path of the metadata file of a lifecycle csv */
export function metadataPathFor(csvPath: string): string {
    return csvPath.replace(/\.csv$/i, "") + ".lifecycle.yml";
}

function asRecord(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
    return typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;
}

function asNumber(value: unknown): number | undefined {
    return typeof value === "number" ? value : undefined;
}

export interface ParsedMetadata {
    metadata: Metadata;
    errors: string[];
}

export function parseMetadata(text: string): ParsedMetadata {
    const doc = parseDocument(text);
    const errors = doc.errors.map((e) => e.message);
    const root = asRecord(doc.toJS());
    const metadata = emptyMetadata();

    metadata.statesCsv = asString(root.states_csv);
    for (const [k, v] of Object.entries(asRecord(root.lifecycle))) {
        const s = asString(v);
        if (s !== undefined) {
            metadata.lifecycle[k] = s;
        }
    }
    if (Array.isArray(root.stages)) {
        for (const raw of root.stages) {
            const s = asRecord(raw);
            const id = asString(s.id);
            if (id === undefined) {
                errors.push("A stage has no id");
                continue;
            }
            metadata.stages.push({ id, name: asString(s.name), column: asNumber(s.column), row: asNumber(s.row), description: asString(s.description) });
        }
    }
    if (Array.isArray(root.transfers)) {
        for (const raw of root.transfers) {
            const { source, trigger, target, ...rest } = asRecord(raw);
            if (typeof source !== "string" || typeof trigger !== "string" || typeof target !== "string") {
                errors.push("A transfer entry needs a source, trigger and target");
                continue;
            }
            const annotations: Record<string, string | boolean> = {};
            for (const [k, v] of Object.entries(rest)) {
                if (typeof v === "string" || typeof v === "boolean") {
                    annotations[k] = v;
                }
            }
            metadata.transfers.push({ source, trigger: trigger as Trigger, target, annotations });
        }
    }
    for (const [state, raw] of Object.entries(asRecord(root.layout))) {
        const p = asRecord(raw);
        const x = asNumber(p.x);
        const y = asNumber(p.y);
        if (x !== undefined && y !== undefined) {
            metadata.layout[state] = { x, y };
        }
    }
    if (Array.isArray(root.scenarios)) {
        for (const raw of root.scenarios) {
            const s = asRecord(raw);
            const name = asString(s.name) ?? "unnamed";
            const steps = Array.isArray(s.steps) ? s.steps.map((x) => String(x)) : [];
            metadata.scenarios.push({ name, start: asString(s.start), steps, expect: asString(s.expect) });
        }
    }
    return { metadata, errors };
}

const HEADER = "# Lifecycle Studio metadata: stages, transfer annotations, layout and scenarios of the lifecycle csv.\nversion: 1\n";

// Never fold long lines, a one line transfer entry stays on one line
const FORMAT = { lineWidth: 0 };

function load(text: string): Document {
    return parseDocument(text.trim() ? text : HEADER);
}

function flow(doc: Document, value: unknown) {
    const node = doc.createNode(value);
    if (isMap(node) || isSeq(node)) {
        node.flow = true;
    }
    return node;
}

/** Set the position of states in the layout section */
export function setLayout(text: string, positions: Record<string, { x: number; y: number }>): string {
    const doc = load(text);
    for (const [state, p] of Object.entries(positions)) {
        doc.setIn(["layout", state], flow(doc, { x: Math.round(p.x), y: Math.round(p.y) }));
    }
    return doc.toString(FORMAT);
}

/** Drop the position of states from the layout section */
export function removeLayout(text: string, states: readonly string[]): string {
    const doc = load(text);
    const layout = doc.get("layout", true);
    if (isMap(layout)) {
        states.forEach((state) => layout.delete(state));
    }
    return doc.toString(FORMAT);
}

/** Drop the layout section */
export function clearLayout(text: string): string {
    const doc = load(text);
    doc.delete("layout");
    return doc.toString(FORMAT);
}

/** Add a scenario, or replace the one with the same name */
export function upsertScenario(text: string, scenario: Scenario): string {
    const doc = load(text);
    const value: Record<string, unknown> = { name: scenario.name };
    if (scenario.start) {
        value.start = scenario.start;
    }
    value.steps = scenario.steps;
    if (scenario.expect) {
        value.expect = scenario.expect;
    }
    const node = doc.createNode(value);
    if (isMap(node)) {
        const steps = node.get("steps", true);
        if (isSeq(steps)) {
            steps.flow = true;
        }
    }
    const seq = doc.get("scenarios", true);
    if (isSeq(seq)) {
        const index = seq.items.findIndex((item) => isMap(item) && item.get("name") === scenario.name);
        if (index >= 0) {
            seq.set(index, node);
        } else {
            seq.add(node);
        }
    } else {
        doc.set("scenarios", doc.createNode([value]));
        const created = doc.get("scenarios", true);
        if (isSeq(created)) {
            created.set(0, node);
        }
    }
    return doc.toString(FORMAT);
}

export function deleteScenario(text: string, name: string): string {
    const doc = load(text);
    const seq = doc.get("scenarios", true);
    if (isSeq(seq)) {
        seq.items = seq.items.filter((item) => !(isMap(item) && item.get("name") === name));
    }
    return doc.toString(FORMAT);
}

/** Set (or remove when empty) the annotations of a transfer */
export function setTransferAnnotations(text: string, entry: TransferAnnotations): string {
    const doc = load(text);
    const value = { source: entry.source, trigger: entry.trigger, target: entry.target, ...entry.annotations };
    const empty = Object.keys(entry.annotations).length === 0;
    const matches = (item: unknown) =>
        isMap(item) && item.get("source") === entry.source && item.get("trigger") === entry.trigger && item.get("target") === entry.target;
    const seq = doc.get("transfers", true);
    if (isSeq(seq)) {
        const index = seq.items.findIndex(matches);
        if (empty) {
            seq.items = seq.items.filter((item) => !matches(item));
        } else if (index >= 0) {
            seq.set(index, flow(doc, value));
        } else {
            seq.add(flow(doc, value));
        }
    } else if (!empty) {
        doc.set("transfers", doc.createNode([]));
        (doc.get("transfers", true) as { add(v: unknown): void }).add(flow(doc, value));
    }
    return doc.toString(FORMAT);
}

/** Drop the layout and transfer annotations of a deleted state, scenarios using it are left to fail */
export function deleteStateInMetadata(text: string, name: string): string {
    if (!text.trim()) {
        return text;
    }
    const doc = load(text);
    const layout = doc.get("layout", true);
    if (isMap(layout)) {
        layout.delete(name);
    }
    const transfers = doc.get("transfers", true);
    if (isSeq(transfers)) {
        transfers.items = transfers.items.filter((item) => !(isMap(item) && (item.get("source") === name || item.get("target") === name)));
    }
    return doc.toString(FORMAT);
}

/** Rename a state in the layout, transfers and scenarios sections */
export function renameStateInMetadata(text: string, from: string, to: string): string {
    if (!text.trim()) {
        return text;
    }
    const doc = load(text);
    const layout = doc.get("layout", true);
    if (isMap(layout) && layout.has(from)) {
        const p = layout.get(from, true);
        layout.delete(from);
        layout.set(to, p);
    }
    const transfers = doc.get("transfers", true);
    if (isSeq(transfers)) {
        for (const item of transfers.items) {
            if (isMap(item)) {
                for (const key of ["source", "target"]) {
                    if (item.get(key) === from) {
                        item.set(key, to);
                    }
                }
            }
        }
    }
    const scenarios = doc.get("scenarios", true);
    if (isSeq(scenarios)) {
        for (const item of scenarios.items) {
            if (!isMap(item)) {
                continue;
            }
            for (const key of ["start", "expect"]) {
                if (item.get(key) === from) {
                    item.set(key, to);
                }
            }
            const steps = item.get("steps", true);
            if (isSeq(steps)) {
                steps.items = steps.items.map((s) => {
                    const event = parseEvent(String(isScalarValue(s)));
                    if (event?.kind === "set_state" && event.target === from) {
                        return doc.createNode(formatEvent({ ...event, target: to }));
                    }
                    if (event?.kind === "create" && event.state === from) {
                        return doc.createNode(formatEvent({ ...event, state: to }));
                    }
                    return s;
                }) as typeof steps.items;
            }
        }
    }
    return doc.toString(FORMAT);
}

function stageValue(stage: StageDefinition): Record<string, unknown> {
    const value: Record<string, unknown> = { id: stage.id };
    for (const key of ["name", "column", "row", "description"] as const) {
        if (stage[key] !== undefined && stage[key] !== "") {
            value[key] = stage[key];
        }
    }
    return value;
}

function stageIndex(seq: unknown, id: string): number {
    return isSeq(seq) ? seq.items.findIndex((item) => isMap(item) && item.get("id") === id) : -1;
}

/** Add a stage at the end of the stages section, or replace the one with the same id */
export function upsertStage(text: string, stage: StageDefinition): string {
    const doc = load(text);
    const node = flow(doc, stageValue(stage));
    const seq = doc.get("stages", true);
    if (isSeq(seq)) {
        const index = stageIndex(seq, stage.id);
        if (index >= 0) {
            seq.set(index, node);
        } else {
            seq.add(node);
        }
    } else {
        doc.set("stages", doc.createNode([]));
        (doc.get("stages", true) as { add(v: unknown): void }).add(node);
    }
    return doc.toString(FORMAT);
}

/** Declare the given stages, in this order, keeping the definitions of the declared ones */
export function setStages(text: string, stages: readonly StageDefinition[]): string {
    const doc = load(text);
    const current = parseMetadata(text).metadata.stages;
    const nodes = stages.map((stage) => flow(doc, stageValue({ ...current.find((s) => s.id === stage.id), ...stage })));
    doc.set("stages", doc.createNode([]));
    const seq = doc.get("stages", true) as { add(v: unknown): void };
    nodes.forEach((node) => seq.add(node));
    return doc.toString(FORMAT);
}

export function deleteStage(text: string, id: string): string {
    const doc = load(text);
    const seq = doc.get("stages", true);
    if (isSeq(seq)) {
        seq.items = seq.items.filter((item) => !(isMap(item) && item.get("id") === id));
    }
    return doc.toString(FORMAT);
}

export function renameStageInMetadata(text: string, from: string, to: string): string {
    const doc = load(text);
    const seq = doc.get("stages", true);
    const index = stageIndex(seq, from);
    if (isSeq(seq) && index >= 0) {
        const item = seq.items[index];
        if (isMap(item)) {
            item.set("id", to);
        }
    }
    return doc.toString(FORMAT);
}

/** Move a stage one place up (-1) or down (+1) in the stages section */
export function moveStage(text: string, id: string, delta: -1 | 1): string {
    const doc = load(text);
    const seq = doc.get("stages", true);
    const index = stageIndex(seq, id);
    if (isSeq(seq) && index >= 0 && index + delta >= 0 && index + delta < seq.items.length) {
        const [item] = seq.items.splice(index, 1);
        seq.items.splice(index + delta, 0, item);
    }
    return doc.toString(FORMAT);
}

export type MetadataOp =
    | { kind: "setLayout"; positions: Record<string, { x: number; y: number }> }
    | { kind: "removeLayout"; states: string[] }
    | { kind: "clearLayout" }
    | { kind: "upsertScenario"; scenario: Scenario }
    | { kind: "deleteScenario"; name: string }
    | { kind: "setTransferAnnotations"; entry: TransferAnnotations }
    | { kind: "upsertStage"; stage: StageDefinition }
    | { kind: "setStages"; stages: StageDefinition[] }
    | { kind: "deleteStage"; id: string }
    | { kind: "renameStage"; from: string; to: string }
    | { kind: "moveStage"; id: string; delta: -1 | 1 };

export function applyMetadataOp(text: string, op: MetadataOp): string {
    switch (op.kind) {
        case "setLayout":
            return setLayout(text, op.positions);
        case "removeLayout":
            return removeLayout(text, op.states);
        case "clearLayout":
            return clearLayout(text);
        case "upsertScenario":
            return upsertScenario(text, op.scenario);
        case "deleteScenario":
            return deleteScenario(text, op.name);
        case "setTransferAnnotations":
            return setTransferAnnotations(text, op.entry);
        case "upsertStage":
            return upsertStage(text, op.stage);
        case "setStages":
            return setStages(text, op.stages);
        case "deleteStage":
            return deleteStage(text, op.id);
        case "renameStage":
            return renameStageInMetadata(text, op.from, op.to);
        case "moveStage":
            return moveStage(text, op.id, op.delta);
    }
}

function isScalarValue(node: unknown): unknown {
    return typeof node === "object" && node !== null && "value" in node ? (node as { value: unknown }).value : node;
}
