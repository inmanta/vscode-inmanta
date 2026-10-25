/**
 * Edits of a lifecycle csv.  Each edit takes the csv text and returns the new text, only the
 * rows that change are rewritten.
 */
import { CsvRow, CsvTable, parseCsv, writeCsv } from "./csv";
import { MetadataOp } from "./metadata";
import { formatTransfer, joinApiSetState, parseTransfer, splitApiSetState, Trigger, TRIGGERS } from "./model";

export type EditOp =
    | { kind: "setCell"; state: string; column: string; value: string }
    | { kind: "setTransfers"; state: string; trigger: Trigger; values: string[] }
    | { kind: "addTransfer"; state: string; trigger: Trigger; value: string }
    | { kind: "addState"; name: string; desiredState: string; after?: string; copyFrom?: string }
    | { kind: "deleteState"; name: string }
    | { kind: "renameState"; from: string; to: string };

export class EditError extends Error {}

/** Edits of the lifecycle csv, the states csv and the metadata files, applied together */
export interface FileChange {
    csv: EditOp[];
    states: EditOp[];
    metadata: MetadataOp[];
}

function columnIndex(table: CsvTable, column: string, create: boolean): number {
    let index = table.header.values.indexOf(column);
    if (index < 0 && create) {
        table.header.values.push(column);
        table.header.raw.push(column);
        index = table.header.values.length - 1;
    }
    return index;
}

function findRow(table: CsvTable, name: string): CsvRow {
    const nameIndex = columnIndex(table, "name", false);
    const row = table.rows.find((r) => r.values[nameIndex] === name);
    if (row === undefined) {
        throw new EditError(`No state named ${name}`);
    }
    return row;
}

function set(table: CsvTable, row: CsvRow, column: string, value: string): void {
    const index = columnIndex(table, column, value !== "");
    if (index < 0) {
        return;
    }
    while (row.values.length <= index) {
        row.values.push("");
    }
    row.values[index] = value;
}

function get(table: CsvTable, row: CsvRow, column: string): string {
    const index = table.header.values.indexOf(column);
    return index < 0 ? "" : (row.values[index] ?? "");
}

/** Replace a state name in a transfer expression, keep it unchanged when it doesn't parse */
function renameInExpression(raw: string, from: string, to: string): string {
    const expr = parseTransfer(raw);
    if (expr === null) {
        return raw;
    }
    return formatTransfer({
        ...expr,
        target: expr.target === from ? to : expr.target,
        escape: expr.escape === from ? to : expr.escape,
    });
}

function references(raw: string, name: string): boolean {
    const expr = parseTransfer(raw);
    return expr !== null && (expr.target === name || expr.escape === name);
}

function mapTransfers(table: CsvTable, row: CsvRow, trigger: Trigger, f: (values: string[]) => string[]): void {
    const current = get(table, row, trigger);
    if (trigger === "on_api_set_state") {
        const before = splitApiSetState(current);
        const after = f(before);
        if (after.join("\0") !== before.join("\0")) {
            set(table, row, trigger, joinApiSetState(after));
        }
    } else {
        const after = f(current ? [current] : []);
        if ((after[0] ?? "") !== current) {
            set(table, row, trigger, after[0] ?? "");
        }
    }
}

export function applyEdit(text: string, op: EditOp): string {
    const table = parseCsv(text);
    if (table.header.values.length === 0) {
        throw new EditError("The csv has no header");
    }
    const nameIndex = columnIndex(table, "name", false);

    switch (op.kind) {
        case "setCell": {
            set(table, findRow(table, op.state), op.column, op.value);
            break;
        }
        case "setTransfers": {
            const values = op.values.filter((v) => v !== "");
            if (op.trigger !== "on_api_set_state" && values.length > 1) {
                throw new EditError(`${op.trigger} holds a single transfer`);
            }
            mapTransfers(table, findRow(table, op.state), op.trigger, () => values);
            break;
        }
        case "addTransfer": {
            mapTransfers(table, findRow(table, op.state), op.trigger, (values) => {
                if (op.trigger === "on_api_set_state") {
                    return values.includes(op.value) ? values : [...values, op.value];
                }
                return [op.value];
            });
            break;
        }
        case "addState": {
            if (!/^[a-z_]+$/.test(op.name)) {
                throw new EditError("A state name can only hold lowercase letters and underscores");
            }
            if (table.rows.some((r) => r.values[nameIndex] === op.name)) {
                throw new EditError(`State ${op.name} already exists`);
            }
            const source = op.copyFrom ? findRow(table, op.copyFrom) : undefined;
            const values = table.header.values.map((column) => {
                if (column === "name") {
                    return op.name;
                }
                if (column === "desired_state") {
                    return op.desiredState;
                }
                return source && !["on_create"].includes(column) ? get(table, source, column) : "";
            });
            const row: CsvRow = { values, raw: [], line: -1 };
            const after = op.after ? table.rows.indexOf(findRow(table, op.after)) : table.rows.length - 1;
            table.rows.splice(after + 1, 0, row);
            break;
        }
        case "deleteState": {
            const row = findRow(table, op.name);
            table.rows.splice(table.rows.indexOf(row), 1);
            for (const other of table.rows) {
                for (const trigger of TRIGGERS) {
                    mapTransfers(table, other, trigger, (values) => values.filter((v) => !references(v, op.name)));
                }
            }
            break;
        }
        case "renameState": {
            if (!/^[a-z_]+$/.test(op.to)) {
                throw new EditError("A state name can only hold lowercase letters and underscores");
            }
            if (table.rows.some((r) => r.values[nameIndex] === op.to)) {
                throw new EditError(`State ${op.to} already exists`);
            }
            set(table, findRow(table, op.from), "name", op.to);
            for (const row of table.rows) {
                for (const trigger of TRIGGERS) {
                    mapTransfers(table, row, trigger, (values) => values.map((v) => renameInExpression(v, op.from, op.to)));
                }
            }
            break;
        }
    }
    return writeCsv(table);
}

/** The states whose transfers reference the given state */
export function referencesTo(text: string, name: string): string[] {
    const table = parseCsv(text);
    const result: string[] = [];
    for (const row of table.rows) {
        const own = get(table, row, "name");
        if (own === name) {
            continue;
        }
        const hit = TRIGGERS.some((trigger) => {
            const raw = get(table, row, trigger);
            const values = trigger === "on_api_set_state" ? splitApiSetState(raw) : raw ? [raw] : [];
            return values.some((v) => references(v, name));
        });
        if (hit) {
            result.push(own);
        }
    }
    return result;
}
