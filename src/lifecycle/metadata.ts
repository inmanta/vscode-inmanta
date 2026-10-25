/**
 * What a lifecycle csv can't hold, in three files next to it:
 * - <name>.transfers.csv: the annotations of the transfers, read by the lifecycle factory
 * - <name>.stages.csv: the stages, in display order
 * - <name>.studio.yml: what only the Lifecycle Studio uses, the layout and the scenarios
 */
import { Document, isMap, isSeq, parseDocument } from "yaml";
import { CsvRow, CsvTable, parseCsv, writeCsv } from "./csv";
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
    stages: StageDefinition[];
    transfers: TransferAnnotations[];
    layout: Record<string, { x: number; y: number }>;
    scenarios: Scenario[];
}

/** The texts of the metadata files, empty when a file doesn't exist */
export interface MetadataTexts {
    transfers: string;
    stages: string;
    studio: string;
}

export type MetadataFile = keyof MetadataTexts;

export const METADATA_FILES: readonly MetadataFile[] = ["transfers", "stages", "studio"];

const SUFFIX: Record<MetadataFile, string> = { transfers: ".transfers.csv", stages: ".stages.csv", studio: ".studio.yml" };

/** The path of a metadata file of a lifecycle csv */
export function metadataPathFor(csvPath: string, file: MetadataFile): string {
    return csvPath.replace(/\.csv$/i, "") + SUFFIX[file];
}

export function emptyTexts(): MetadataTexts {
    return { transfers: "", stages: "", studio: "" };
}

/** The triggers whose transfers the lifecycle factory annotates */
export const TRANSFER_ANNOTATION_TRIGGERS: readonly Trigger[] = ["on_create", "on_update", "on_delete", "on_api_set_state", "on_auto", "on_deployed"];

const TRANSFER_KEY = ["source", "trigger", "target"];
const STAGE_COLUMNS = ["id", "name", "description"];

function isAnnotation(column: string): boolean {
    return column.startsWith("web_") || column.startsWith("inmanta_");
}

/** The transfer rows the lifecycle factory rejects: they must match a transfer of the csv */
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
    return { stages: [], transfers: [], layout: {}, scenarios: [] };
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

export interface MetadataError {
    file: MetadataFile;
    message: string;
}

export interface ParsedMetadata {
    metadata: Metadata;
    errors: MetadataError[];
}

// ---------- csv tables ----------

function loadTable(text: string, header: readonly string[]): CsvTable {
    if (text.trim()) {
        return parseCsv(text);
    }
    return { header: { values: [...header], raw: [...header], line: 0 }, rows: [], eol: "\n", trailingEol: true, blankAfter: 0 };
}

function get(table: CsvTable, row: CsvRow, column: string): string {
    const index = table.header.values.indexOf(column);
    return index < 0 ? "" : (row.values[index] ?? "");
}

/** Set a cell, a new column is added to all rows */
function set(table: CsvTable, row: CsvRow, column: string, value: string): void {
    let index = table.header.values.indexOf(column);
    if (index < 0) {
        if (value === "") {
            return;
        }
        table.header.values.push(column);
        table.header.raw.push(column);
        index = table.header.values.length - 1;
    }
    for (const r of [...table.rows, row]) {
        while (r.values.length <= index) {
            r.values.push("");
        }
    }
    row.values[index] = value;
}

function newRow(table: CsvTable): CsvRow {
    return { values: table.header.values.map(() => ""), raw: [], line: -1 };
}

function records(table: CsvTable): Record<string, string>[] {
    return table.rows.map((row) => Object.fromEntries(table.header.values.map((column, i) => [column, row.values[i] ?? ""])));
}

// ---------- parsing ----------

function parseTransfers(text: string, errors: MetadataError[]): TransferAnnotations[] {
    if (!text.trim()) {
        return [];
    }
    const table = parseCsv(text);
    const unknown = table.header.values.filter((c) => !TRANSFER_KEY.includes(c) && !isAnnotation(c));
    if (unknown.length) {
        errors.push({ file: "transfers", message: `The columns ${unknown.join(", ")} are not annotations, the factory rejects them` });
    }
    return records(table).map((r) => {
        const annotations: Record<string, string | boolean> = {};
        for (const [k, v] of Object.entries(r)) {
            if (isAnnotation(k) && v !== "") {
                // The factory reads true and false as booleans
                annotations[k] = v === "true" ? true : v === "false" ? false : v;
            }
        }
        return { source: r.source, trigger: r.trigger as Trigger, target: r.target, annotations };
    });
}

function parseStages(text: string, studio: Record<string, unknown>, errors: MetadataError[]): StageDefinition[] {
    if (!text.trim()) {
        return [];
    }
    const placement = asRecord(studio.stage_layout);
    return records(parseCsv(text)).flatMap((r) => {
        if (!r.id) {
            errors.push({ file: "stages", message: "A stage has no id" });
            return [];
        }
        const p = asRecord(placement[r.id]);
        return [{ id: r.id, name: r.name || undefined, column: asNumber(p.column), row: asNumber(p.row), description: r.description || undefined }];
    });
}

export function parseMetadata(texts: MetadataTexts): ParsedMetadata {
    const doc = parseDocument(texts.studio);
    const errors: MetadataError[] = doc.errors.map((e) => ({ file: "studio", message: e.message }));
    const root = asRecord(doc.toJS());
    const metadata = emptyMetadata();

    metadata.statesCsv = asString(root.states_csv);
    metadata.transfers = parseTransfers(texts.transfers, errors);
    metadata.stages = parseStages(texts.stages, root, errors);
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

// ---------- studio file ----------

const HEADER = "# Lifecycle Studio: the layout and scenarios of the lifecycle csv, not used by the model.\nversion: 1\n";

// Never fold long lines, a one line entry stays on one line
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

/** Set or clear the column and row of a stage */
function setStagePlacement(text: string, stage: StageDefinition): string {
    const doc = load(text);
    const placement: Record<string, number> = {};
    if (stage.column !== undefined) {
        placement.column = stage.column;
    }
    if (stage.row !== undefined) {
        placement.row = stage.row;
    }
    if (Object.keys(placement).length) {
        doc.setIn(["stage_layout", stage.id], flow(doc, placement));
    } else if (!text.trim()) {
        return text;
    } else {
        doc.deleteIn(["stage_layout", stage.id]);
    }
    return doc.toString(FORMAT);
}

function renameKey(text: string, section: string, from: string, to: string): string {
    if (!text.trim()) {
        return text;
    }
    const doc = load(text);
    const map = doc.get(section, true);
    if (isMap(map) && map.has(from)) {
        const value = map.get(from, true);
        map.delete(from);
        map.set(to, value);
    }
    return doc.toString(FORMAT);
}

function deleteKey(text: string, section: string, key: string): string {
    if (!text.trim()) {
        return text;
    }
    const doc = load(text);
    const map = doc.get(section, true);
    if (isMap(map)) {
        map.delete(key);
    }
    return doc.toString(FORMAT);
}

/** Rename a state in the layout and scenarios of the studio file */
function renameStateInStudio(text: string, from: string, to: string): string {
    if (!text.trim()) {
        return text;
    }
    const doc = parseDocument(renameKey(text, "layout", from, to));
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

// ---------- transfers csv ----------

function matchesTransfer(table: CsvTable, row: CsvRow, entry: { source: string; trigger: string; target: string }): boolean {
    return get(table, row, "source") === entry.source && get(table, row, "trigger") === entry.trigger && get(table, row, "target") === entry.target;
}

/** Set (or remove when empty) the annotations of a transfer */
export function setTransferAnnotations(text: string, entry: TransferAnnotations): string {
    const table = loadTable(text, TRANSFER_KEY);
    const empty = Object.keys(entry.annotations).length === 0;
    let row = table.rows.find((r) => matchesTransfer(table, r, entry));
    if (empty) {
        if (row === undefined) {
            return text;
        }
        table.rows = table.rows.filter((r) => r !== row);
        return writeCsv(table);
    }
    if (row === undefined) {
        row = newRow(table);
        table.rows.push(row);
        set(table, row, "source", entry.source);
        set(table, row, "trigger", entry.trigger);
        set(table, row, "target", entry.target);
    }
    for (const column of new Set([...table.header.values.filter(isAnnotation), ...Object.keys(entry.annotations)])) {
        const value = entry.annotations[column];
        set(table, row, column, value === undefined ? "" : String(value));
    }
    return writeCsv(table);
}

function renameStateInTransfers(text: string, from: string, to: string): string {
    if (!text.trim()) {
        return text;
    }
    const table = parseCsv(text);
    for (const row of table.rows) {
        for (const column of ["source", "target"]) {
            if (get(table, row, column) === from) {
                set(table, row, column, to);
            }
        }
    }
    return writeCsv(table);
}

function deleteStateInTransfers(text: string, name: string): string {
    if (!text.trim()) {
        return text;
    }
    const table = parseCsv(text);
    table.rows = table.rows.filter((row) => get(table, row, "source") !== name && get(table, row, "target") !== name);
    return writeCsv(table);
}

// ---------- stages csv ----------

function stageRow(table: CsvTable, id: string): CsvRow | undefined {
    return table.rows.find((r) => get(table, r, "id") === id);
}

function writeStage(table: CsvTable, stage: StageDefinition): CsvRow {
    let row = stageRow(table, stage.id);
    if (row === undefined) {
        row = newRow(table);
        set(table, row, "id", stage.id);
    }
    set(table, row, "name", stage.name ?? "");
    set(table, row, "description", stage.description ?? "");
    return row;
}

/** Add a stage at the end, or replace the one with the same id */
function upsertStage(texts: MetadataTexts, stage: StageDefinition): MetadataTexts {
    const table = loadTable(texts.stages, STAGE_COLUMNS);
    const exists = stageRow(table, stage.id) !== undefined;
    const row = writeStage(table, stage);
    if (!exists) {
        table.rows.push(row);
    }
    return { ...texts, stages: writeCsv(table), studio: setStagePlacement(texts.studio, stage) };
}

/** Declare the given stages, in this order, keeping the definitions of the declared ones */
function setStages(texts: MetadataTexts, stages: readonly StageDefinition[]): MetadataTexts {
    const current = parseMetadata(texts).metadata.stages;
    const table = loadTable(texts.stages, STAGE_COLUMNS);
    table.rows = stages.map((stage) => writeStage(table, { ...current.find((s) => s.id === stage.id), ...stage }));
    const studio = stages.reduce((text, stage) => (stage.column !== undefined || stage.row !== undefined ? setStagePlacement(text, stage) : text), texts.studio);
    return { ...texts, stages: writeCsv(table), studio };
}

function deleteStage(texts: MetadataTexts, id: string): MetadataTexts {
    const table = loadTable(texts.stages, STAGE_COLUMNS);
    table.rows = table.rows.filter((r) => get(table, r, "id") !== id);
    return { ...texts, stages: writeCsv(table), studio: deleteKey(texts.studio, "stage_layout", id) };
}

function renameStage(texts: MetadataTexts, from: string, to: string): MetadataTexts {
    const table = loadTable(texts.stages, STAGE_COLUMNS);
    const row = stageRow(table, from);
    if (row !== undefined) {
        set(table, row, "id", to);
    }
    return { ...texts, stages: writeCsv(table), studio: renameKey(texts.studio, "stage_layout", from, to) };
}

/** Move a stage one place up (-1) or down (+1) */
function moveStage(texts: MetadataTexts, id: string, delta: -1 | 1): MetadataTexts {
    const table = loadTable(texts.stages, STAGE_COLUMNS);
    const index = table.rows.findIndex((r) => get(table, r, "id") === id);
    if (index >= 0 && index + delta >= 0 && index + delta < table.rows.length) {
        const [row] = table.rows.splice(index, 1);
        table.rows.splice(index + delta, 0, row);
    }
    return { ...texts, stages: writeCsv(table) };
}

// ---------- operations ----------

/** Follow a renamed state in the transfers and studio files */
export function renameStateInMetadata(texts: MetadataTexts, from: string, to: string): MetadataTexts {
    return { ...texts, transfers: renameStateInTransfers(texts.transfers, from, to), studio: renameStateInStudio(texts.studio, from, to) };
}

/** Drop the transfer annotations and layout of a deleted state, scenarios using it are left to fail */
export function deleteStateInMetadata(texts: MetadataTexts, name: string): MetadataTexts {
    return { ...texts, transfers: deleteStateInTransfers(texts.transfers, name), studio: deleteKey(texts.studio, "layout", name) };
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

/** Apply an operation, the files it doesn't touch keep their text */
export function applyMetadataOp(texts: MetadataTexts, op: MetadataOp): MetadataTexts {
    switch (op.kind) {
        case "setLayout":
            return { ...texts, studio: setLayout(texts.studio, op.positions) };
        case "removeLayout":
            return { ...texts, studio: texts.studio.trim() ? removeLayout(texts.studio, op.states) : texts.studio };
        case "clearLayout":
            return { ...texts, studio: clearLayout(texts.studio) };
        case "upsertScenario":
            return { ...texts, studio: upsertScenario(texts.studio, op.scenario) };
        case "deleteScenario":
            return { ...texts, studio: deleteScenario(texts.studio, op.name) };
        case "setTransferAnnotations":
            return { ...texts, transfers: setTransferAnnotations(texts.transfers, op.entry) };
        case "upsertStage":
            return upsertStage(texts, op.stage);
        case "setStages":
            return setStages(texts, op.stages);
        case "deleteStage":
            return deleteStage(texts, op.id);
        case "renameStage":
            return renameStage(texts, op.from, op.to);
        case "moveStage":
            return moveStage(texts, op.id, op.delta);
    }
}

/** The text of a new, empty metadata file */
export function newFileText(file: MetadataFile): string {
    return { transfers: TRANSFER_KEY.join(",") + "\n", stages: STAGE_COLUMNS.join(",") + "\n", studio: HEADER }[file];
}

function isScalarValue(node: unknown): unknown {
    return typeof node === "object" && node !== null && "value" in node ? (node as { value: unknown }).value : node;
}
