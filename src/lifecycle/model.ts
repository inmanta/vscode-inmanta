/**
 * The csv lifecycle as defined by the future::lsm::fsm module: the exporting states (XState)
 * of the lifecycle csv and the desired state options of the states csv.
 * This mirrors csv_lifecycle and Transfer.parse in inmanta_plugins/future/lsm/fsm.py.
 */
import { CsvRow, CsvTable, parseCsv } from "./csv";

export const TRIGGERS = [
    "on_create",
    "on_update",
    "on_delete",
    "on_api_set_state",
    "on_auto",
    "on_deployed",
    "on_failed",
    "on_non_compliant",
] as const;
export type Trigger = (typeof TRIGGERS)[number];

/** Triggers whose transfer goes through the expression syntax but only uses its target */
export const RESOURCE_TRIGGERS: readonly Trigger[] = ["on_deployed", "on_failed", "on_non_compliant"];

export const BASE_COLUMNS = ["name", "label", "current", "previous", "desired_state", ...TRIGGERS] as const;
export const LABELS = ["success", "info", "warning", "danger"] as const;
export const ATTRIBUTE_SETS = ["active", "candidate", "rollback"] as const;

export interface TransferExpr {
    validate: boolean;
    rollback: boolean;
    target: string;
    escape: string | null;
}

// Groups: 1 validate target, 2 validate escape, 3 plain target, 4 rollback target
const TRANSFER_RE = /^(?:(?:validate\(([a-z_]+)(?:[,]\s*([a-z_]+))?\))|([a-z_]+)|(?:rollback\(([a-z_]+)\)))$/;

/**
 * Parse a transfer expression: target, validate(target), validate(target, escape) or rollback(target).
 */
export function parseTransfer(raw: string): TransferExpr | null {
    const m = TRANSFER_RE.exec(raw);
    if (m === null) {
        return null;
    }
    if (m[1] !== undefined) {
        return { validate: true, rollback: false, target: m[1], escape: m[2] ?? null };
    }
    if (m[3] !== undefined) {
        return { validate: false, rollback: false, target: m[3], escape: null };
    }
    return { validate: false, rollback: true, target: m[4], escape: null };
}

export function formatTransfer(expr: TransferExpr): string {
    if (expr.validate) {
        return expr.escape ? `validate(${expr.target}, ${expr.escape})` : `validate(${expr.target})`;
    }
    return expr.rollback ? `rollback(${expr.target})` : expr.target;
}

/**
 * Split the on_api_set_state cell the way fsm.py does: on every comma, stripping whitespace.
 */
export function splitApiSetState(raw: string): string[] {
    return raw
        .split(",")
        .filter((x) => x !== "")
        .map((x) => x.trim());
}

/**
 * Join transfer expressions into one on_api_set_state cell.
 */
export function joinApiSetState(raws: readonly string[]): string {
    return raws.join(", ");
}

export interface XState {
    name: string;
    desiredState: string;
    label: string | null;
    current: string | null;
    previous: string | null;
    /** Raw transfer expressions per trigger, on_api_set_state may have several */
    triggers: Record<Trigger, string[]>;
    /** Annotations from the row, merged over the defaults of the states csv */
    annotations: Record<string, string>;
    /** Annotations set on the row itself */
    ownAnnotations: Record<string, string>;
    /** Index of the row in the csv table */
    row: number;
    /** Zero-based line of the row in the csv text */
    line: number;
}

export function isAnnotation(column: string): boolean {
    return column.startsWith("web_") || column.startsWith("inmanta_");
}

function rowAnnotations(table: CsvTable, row: CsvRow): Record<string, string> {
    const result: Record<string, string> = {};
    table.header.values.forEach((column, i) => {
        const value = row.values[i] ?? "";
        if (isAnnotation(column) && value) {
            result[column] = value;
        }
    });
    return result;
}

function rowDict(table: CsvTable, row: CsvRow): Record<string, string> {
    const result: Record<string, string> = {};
    table.header.values.forEach((column, i) => {
        result[column] = row.values[i] ?? "";
    });
    return result;
}

export interface DesiredStateOptions {
    name: string;
    createdChild: string | null;
    removedChild: string | null;
    /** All the other non annotation columns, in csv order */
    columns: Record<string, string>;
    annotations: Record<string, string>;
    row: number;
    line: number;
}

export interface StatesFile {
    table: CsvTable;
    options: DesiredStateOptions[];
    /** The project specific columns, in csv order */
    columns: string[];
}

export function parseStatesCsv(text: string): StatesFile {
    const table = parseCsv(text);
    const columns = table.header.values.filter(
        (c) => !["name", "created_child", "removed_child"].includes(c) && !isAnnotation(c),
    );
    const options = table.rows.map((row, index) => {
        const d = rowDict(table, row);
        const extra: Record<string, string> = {};
        for (const c of columns) {
            extra[c] = d[c];
        }
        return {
            name: d.name ?? "",
            createdChild: d.created_child || null,
            removedChild: d.removed_child || null,
            columns: extra,
            annotations: rowAnnotations(table, row),
            row: index,
            line: row.line,
        };
    });
    return { table, options, columns };
}

/**
 * Whether a column of the states csv only holds booleans, so it can be shown as a flag.
 */
export function isFlagColumn(states: StatesFile, column: string): boolean {
    const values = states.options.map((o) => o.columns[column].toLowerCase()).filter((v) => v !== "");
    return values.length > 0 && values.every((v) => v === "true" || v === "false");
}

export interface LifecycleFile {
    table: CsvTable;
    states: XState[];
}

/**
 * Parse the lifecycle csv.  The annotations of the states csv are the defaults of the
 * annotations of each state, per desired state.
 */
export function parseLifecycleCsv(text: string, states?: StatesFile): LifecycleFile {
    const table = parseCsv(text);
    const defaults = new Map<string, Record<string, string>>();
    for (const option of states?.options ?? []) {
        defaults.set(option.name, option.annotations);
    }

    const result = table.rows.map((row, index): XState => {
        const d = rowDict(table, row);
        const triggers = {} as Record<Trigger, string[]>;
        for (const trigger of TRIGGERS) {
            const raw = d[trigger] ?? "";
            triggers[trigger] = trigger === "on_api_set_state" ? splitApiSetState(raw) : raw ? [raw] : [];
        }
        const own = rowAnnotations(table, row);
        return {
            name: d.name ?? "",
            desiredState: d.desired_state ?? "",
            label: d.label || null,
            current: d.current || null,
            previous: d.previous || null,
            triggers,
            annotations: { ...(defaults.get(d.desired_state ?? "") ?? {}), ...own },
            ownAnnotations: own,
            row: index,
            line: row.line,
        };
    });
    return { table, states: result };
}

/**
 * Whether the header of a csv file looks like a lifecycle csv.
 */
export function isLifecycleHeader(header: readonly string[]): boolean {
    return header.includes("name") && header.includes("desired_state") && header.some((c) => c.startsWith("on_"));
}

/**
 * Call the callback for each transfer of a state, in the order fsm.cf creates them.
 */
export function forEachTransfer(
    state: XState,
    callback: (trigger: Trigger, raw: string, expr: TransferExpr | null, index: number) => void,
): void {
    for (const trigger of TRIGGERS) {
        state.triggers[trigger].forEach((raw, index) => callback(trigger, raw, parseTransfer(raw), index));
    }
}
