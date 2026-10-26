/**
 * The Table mode of the Lifecycle Studio: the lifecycle csv, the states csv and the transfers csv
 * as tables of typed columns, with the checks and suggestions of each column type, and the
 * edits that write a changed cell back to its file.
 */
import { AnnotationTarget, annotationHint, annotationKey, annotationKeys } from "./annotations";
import { cell } from "./csv";
import { EditOp, FileChange } from "./edit";
import { Issue, Severity } from "./lint";
import { Metadata, TRANSFER_ANNOTATION_TRIGGERS } from "./metadata";
import {
    ATTRIBUTE_SETS,
    BASE_COLUMNS,
    isAnnotation,
    isFlagColumn,
    joinApiSetState,
    LABELS,
    LifecycleFile,
    parseTransfer,
    RESOURCE_TRIGGERS,
    splitApiSetState,
    StatesFile,
    Trigger,
    TRIGGERS,
} from "./model";

export type TableTab = "lifecycle" | "states" | "transfers";

/** What a column holds, it picks the checks, the suggestions and the cell rendering */
export type ColumnKind = "name" | "label" | "set" | "desired" | "transfer" | "transfers" | "icon" | "stage" | "bool" | "choice" | "text" | "fixed";

export interface TableColumn {
    key: string;
    group: string;
    kind: ColumnKind;
    /** The trigger of a transfer column */
    trigger?: Trigger;
    /** The values of a choice column */
    values?: readonly string[];
    /** What the column is for */
    hint?: string;
}

export interface CellIssue {
    severity: Severity;
    message: string;
}

export interface TableRow {
    id: string;
    cells: Record<string, string>;
    issues: Record<string, CellIssue[]>;
    /** Issues about the row that are not about one of its cells */
    rowIssues: CellIssue[];
}

export interface TableModel {
    tab: TableTab;
    columns: TableColumn[];
    rows: TableRow[];
}

export interface CellChange {
    row: string;
    column: string;
    value: string;
}

export interface Suggestion {
    value: string;
    detail?: string;
}

/** The names the checks and suggestions of the columns refer to */
export interface TableContext {
    states: string[];
    desiredStates: string[];
    stages: string[];
    icons: readonly string[];
}

const STATE_NAME = /^[a-z_]+$/;
const STAGE_ID = /^[A-Za-z0-9_-]+$/;
const DEFAULT_ANNOTATIONS = ["web_label", "web_icon", "web_stage", "web_description"];
const KIND: Record<string, ColumnKind> = { text: "text", icon: "icon", stage: "stage", boolean: "bool", choice: "choice" };

function annotationColumn(key: string, on: AnnotationTarget, group: string): TableColumn {
    const known = annotationKey(key, on);
    return known
        ? { key, group, kind: KIND[known.type], values: known.values, hint: annotationHint(known) }
        : { key, group, kind: "text", hint: key.startsWith("web_") ? "Not a known web_* annotation" : undefined };
}

function triggerColumn(trigger: Trigger): TableColumn {
    return {
        key: trigger,
        group: RESOURCE_TRIGGERS.includes(trigger) ? "Resource transfers" : "API transfers",
        kind: trigger === "on_api_set_state" ? "transfers" : "transfer",
        trigger,
    };
}

function pushIssue(row: TableRow | undefined, column: string | undefined, issue: CellIssue): void {
    if (row === undefined) {
        return;
    }
    if (column !== undefined && column in row.cells) {
        (row.issues[column] ??= []).push(issue);
    } else {
        row.rowIssues.push(issue);
    }
}

/** The lifecycle csv, one row per state */
export function lifecycleTable(lifecycle: LifecycleFile, issues: readonly Issue[], extraColumns: readonly string[] = []): TableModel {
    const header = lifecycle.table.header.values;
    // A fixed order, writing a first value to a column doesn't move it
    const annotations = [...new Set([...DEFAULT_ANNOTATIONS, ...header.filter(isAnnotation), ...extraColumns.filter(isAnnotation)])];
    const other = header.filter((c) => !isAnnotation(c) && !(BASE_COLUMNS as readonly string[]).includes(c));
    const columns: TableColumn[] = [
        { key: "name", group: "State", kind: "name" },
        { key: "label", group: "State", kind: "label" },
        { key: "desired_state", group: "State", kind: "desired" },
        { key: "current", group: "State", kind: "set" },
        { key: "previous", group: "State", kind: "set" },
        ...TRIGGERS.map(triggerColumn),
        ...annotations.map((key) => annotationColumn(key, "state", "Annotations")),
        ...other.map((key): TableColumn => ({ key, group: "Other", kind: "text" })),
    ];
    const rows = lifecycle.states.map((x): TableRow => {
        const csvRow = lifecycle.table.rows[x.row];
        return {
            id: x.name,
            cells: Object.fromEntries(columns.map((c) => [c.key, cell(lifecycle.table, csvRow, c.key)])),
            issues: {},
            rowIssues: [],
        };
    });
    const byName = new Map(rows.map((r) => [r.id, r]));
    const byLine = new Map(lifecycle.states.map((x) => [x.line, byName.get(x.name)]));
    for (const issue of issues.filter((i) => !i.inStatesFile)) {
        const row = issue.state !== undefined ? byName.get(issue.state) : issue.line !== undefined ? byLine.get(issue.line) : undefined;
        pushIssue(row, issue.column, { severity: issue.severity, message: issue.message });
    }
    return { tab: "lifecycle", columns, rows };
}

/** The states csv, one row per desired state */
export function statesTable(states: StatesFile, issues: readonly Issue[], extraColumns: readonly string[] = []): TableModel {
    const header = states.table.header.values;
    const annotations = [...new Set([...header.filter(isAnnotation), ...extraColumns.filter(isAnnotation)])];
    const columns: TableColumn[] = [
        { key: "name", group: "Desired state", kind: "name" },
        { key: "created_child", group: "Embedded entities", kind: "desired" },
        { key: "removed_child", group: "Embedded entities", kind: "desired" },
        ...states.columns.map((key): TableColumn => ({ key, group: "Options", kind: isFlagColumn(states, key) ? "bool" : "text" })),
        ...annotations.map((key) => annotationColumn(key, "state", "Annotation defaults")),
    ];
    const rows = states.options.map((o): TableRow => ({
        id: o.name,
        cells: Object.fromEntries(columns.map((c) => [c.key, cell(states.table, states.table.rows[o.row], c.key)])),
        issues: {},
        rowIssues: [],
    }));
    const byLine = new Map(states.options.map((o, i) => [o.line, rows[i]]));
    for (const issue of issues.filter((i) => i.inStatesFile && i.line !== undefined)) {
        pushIssue(byLine.get(issue.line!), issue.column, { severity: issue.severity, message: issue.message });
    }
    return { tab: "states", columns, rows };
}

export function transferRowId(source: string, trigger: string, target: string): string {
    return `${source} ${trigger} ${target}`;
}

/** Every transfer the factory annotates, with its annotations from the transfers csv */
export function transfersTable(lifecycle: LifecycleFile, metadata: Metadata, problems: readonly string[] = [], extraColumns: readonly string[] = []): TableModel {
    const used = metadata.transfers.flatMap((t) => Object.keys(t.annotations));
    const annotations = [...new Set([...annotationKeys("transfer").map((a) => a.key), ...used, ...extraColumns.filter(isAnnotation)])];
    const columns: TableColumn[] = [
        { key: "source", group: "Transfer", kind: "fixed" },
        { key: "trigger", group: "Transfer", kind: "fixed" },
        { key: "target", group: "Transfer", kind: "fixed" },
        ...annotations.map((key) => annotationColumn(key, "transfer", "Annotations")),
    ];
    const rows = new Map<string, TableRow>();
    const addRow = (source: string, trigger: string, target: string) => {
        const id = transferRowId(source, trigger, target);
        if (!rows.has(id)) {
            const cells: Record<string, string> = { source, trigger, target };
            annotations.forEach((a) => (cells[a] = ""));
            rows.set(id, { id, cells, issues: {}, rowIssues: [] });
        }
        return rows.get(id)!;
    };
    for (const x of lifecycle.states) {
        for (const trigger of TRANSFER_ANNOTATION_TRIGGERS) {
            for (const raw of x.triggers[trigger]) {
                const expr = parseTransfer(raw);
                if (expr !== null) {
                    addRow(x.name, trigger, expr.target);
                }
            }
        }
    }
    for (const entry of metadata.transfers) {
        const row = addRow(entry.source, entry.trigger, entry.target);
        for (const [key, value] of Object.entries(entry.annotations)) {
            row.cells[key] = String(value);
        }
    }
    for (const problem of problems) {
        const match = /^transfer (\S+)\.(\S+) -> (\S+): (.*)$/.exec(problem);
        if (match) {
            rows.get(transferRowId(match[1], match[2], match[3]))?.rowIssues.push({ severity: "error", message: match[4] });
        }
    }
    return { tab: "transfers", columns, rows: [...rows.values()] };
}

/** The expressions of a transfer cell, on_api_set_state holds several */
function expressions(column: TableColumn, value: string): string[] {
    return column.kind === "transfers" ? splitApiSetState(value) : value.trim() ? [value.trim()] : [];
}

/** The problems of a value for a cell, checked while typing */
export function checkCell(column: TableColumn, value: string, row: string, model: TableModel, context: TableContext): CellIssue[] {
    const error = (message: string): CellIssue[] => [{ severity: "error", message }];
    const warning = (message: string): CellIssue[] => [{ severity: "warning", message }];
    switch (column.kind) {
        case "name":
            if (!STATE_NAME.test(value)) {
                return error("Only lowercase letters and underscores");
            }
            return model.rows.some((r) => r.id === value && r.id !== row) ? error(`${value} already exists`) : [];
        case "label":
            return value && !(LABELS as readonly string[]).includes(value) ? error(`Expected one of ${LABELS.join(", ")}`) : [];
        case "set":
            return value && !(ATTRIBUTE_SETS as readonly string[]).includes(value) ? error(`Expected one of ${ATTRIBUTE_SETS.join(", ")}`) : [];
        case "desired":
            if (!value) {
                return column.key === "desired_state" ? error("Every state needs a desired state") : [];
            }
            return context.desiredStates.length && !context.desiredStates.includes(value) ? warning(`${value} is not a desired state of the states csv`) : [];
        case "transfer":
        case "transfers": {
            const issues: CellIssue[] = [];
            for (const raw of expressions(column, value)) {
                const expr = parseTransfer(raw);
                if (expr === null) {
                    issues.push({ severity: "error", message: `${raw}: expected target, validate(target), validate(target, error_target) or rollback(target)` });
                    continue;
                }
                for (const name of [expr.target, expr.escape].filter((n): n is string => n !== null)) {
                    if (!context.states.includes(name)) {
                        issues.push({ severity: "error", message: `${raw}: no state ${name}` });
                    }
                }
                if (column.trigger && RESOURCE_TRIGGERS.includes(column.trigger) && (expr.validate || expr.rollback)) {
                    issues.push({ severity: "warning", message: `${raw}: ${column.trigger} only uses the target state` });
                }
            }
            return issues;
        }
        case "icon":
            return value && !context.icons.includes(value) ? warning(`${value} is not a Font Awesome icon, the web console shows a question mark`) : [];
        case "stage":
            return value && !STAGE_ID.test(value) ? error("A stage id can only hold letters, digits, underscores and dashes") : [];
        case "bool":
            return value && value !== "true" && value !== "false" ? error("Expected true or false") : [];
        case "choice":
            return value && !column.values!.includes(value) ? error(`Expected one of ${column.values!.join(", ")}`) : [];
        default:
            return [];
    }
}

/** The candidates that contain the typed text, the ones starting with it first */
export function rank(candidates: readonly Suggestion[], typed: string, limit: number): Suggestion[] {
    const query = typed.toLowerCase();
    const prefix = candidates.filter((c) => c.value.toLowerCase().startsWith(query));
    const inner = candidates.filter((c) => !c.value.toLowerCase().startsWith(query) && c.value.toLowerCase().includes(query));
    return [...prefix, ...inner].slice(0, limit);
}

function transferSuggestions(typed: string, resource: boolean, context: TableContext): Suggestion[] {
    const escape = /^validate\(([a-z_]+),\s*([a-z_]*)$/.exec(typed);
    if (escape) {
        return context.states.map((s) => ({ value: `validate(${escape[1]}, ${s})`, detail: `on failure go to ${s}` }));
    }
    return context.states.flatMap((s): Suggestion[] =>
        resource
            ? [{ value: s }]
            : [{ value: s }, { value: `validate(${s})`, detail: "validate first" }, { value: `rollback(${s})`, detail: "restore the rollback set" }],
    );
}

/** The values to complete the typed value of a cell with */
export function suggestCell(column: TableColumn, typed: string, context: TableContext): Suggestion[] {
    switch (column.kind) {
        case "label":
            return rank(LABELS.map((value) => ({ value })), typed, 20);
        case "set":
            return rank(ATTRIBUTE_SETS.map((value) => ({ value })), typed, 20);
        case "desired":
            return rank(context.desiredStates.map((value) => ({ value })), typed, 40);
        case "bool":
            return rank([{ value: "true" }, { value: "false" }], typed, 2);
        case "choice":
            return rank(column.values!.map((value) => ({ value })), typed, 20);
        case "stage":
            return rank(context.stages.map((value) => ({ value })), typed, 40);
        case "icon":
            return rank(context.icons.map((value) => ({ value })), typed, 60);
        case "transfer":
            return rank(transferSuggestions(typed.trim(), RESOURCE_TRIGGERS.includes(column.trigger!), context), typed.trim(), 40);
        case "transfers": {
            // Complete the last expression of the list
            const cut = typed.lastIndexOf(",");
            const head = cut >= 0 ? typed.slice(0, cut + 1) + " " : "";
            const last = typed.slice(cut + 1).trim();
            return rank(transferSuggestions(last, false, context), last, 40).map((s) => ({ ...s, value: head + s.value }));
        }
        default:
            return [];
    }
}

export function isEditable(column: TableColumn): boolean {
    return column.kind !== "fixed";
}

/** The edits that write the changed cells to their file */
export function planChanges(model: TableModel, changes: readonly CellChange[], lifecycle: LifecycleFile, metadata: Metadata): FileChange {
    const columns = new Map(model.columns.map((c) => [c.key, c]));
    const relevant = changes.filter((c) => {
        const column = columns.get(c.column);
        const row = model.rows.find((r) => r.id === c.row);
        return column !== undefined && isEditable(column) && row !== undefined && row.cells[c.column] !== c.value;
    });
    const result: FileChange = { csv: [], states: [], metadata: [] };
    const normalize = (change: CellChange) => (columns.get(change.column)?.kind === "transfers" ? joinApiSetState(splitApiSetState(change.value)) : change.value.trim());

    if (model.tab === "lifecycle") {
        // Renames go last, the other edits find the rows by their old name
        const cells = relevant.filter((c) => c.column !== "name");
        const renames = relevant.filter((c) => c.column === "name");
        result.csv.push(
            ...cells.map((c): EditOp => ({ kind: "setCell", state: c.row, column: c.column, value: normalize(c) })),
            ...renames.map((c): EditOp => ({ kind: "renameState", from: c.row, to: c.value.trim() })),
        );
    } else if (model.tab === "states") {
        const cells = relevant.filter((c) => c.column !== "name");
        const renames = relevant.filter((c) => c.column === "name");
        result.states.push(
            ...cells.map((c): EditOp => ({ kind: "setCell", state: c.row, column: c.column, value: normalize(c) })),
            ...renames.map((c): EditOp => ({ kind: "setCell", state: c.row, column: "name", value: c.value.trim() })),
        );
        // A renamed desired state is renamed in the lifecycle csv too
        for (const rename of renames) {
            for (const x of lifecycle.states.filter((s) => s.desiredState === rename.row)) {
                result.csv.push({ kind: "setCell", state: x.name, column: "desired_state", value: rename.value.trim() });
            }
        }
    } else {
        const byRow = new Map<string, CellChange[]>();
        relevant.forEach((c) => byRow.set(c.row, [...(byRow.get(c.row) ?? []), c]));
        for (const [id, rowChanges] of byRow) {
            const row = model.rows.find((r) => r.id === id)!;
            const { source, trigger, target } = row.cells;
            const annotations: Record<string, string | boolean> = {};
            for (const entry of metadata.transfers.filter((t) => t.source === source && t.trigger === trigger && t.target === target)) {
                Object.assign(annotations, entry.annotations);
            }
            for (const change of rowChanges) {
                const value = change.value.trim();
                if (value === "") {
                    delete annotations[change.column];
                } else {
                    annotations[change.column] = value === "true" ? true : value === "false" ? false : value;
                }
            }
            result.metadata.push({ kind: "setTransferAnnotations", entry: { source, trigger: trigger as Trigger, target, annotations } });
        }
    }
    return result;
}
