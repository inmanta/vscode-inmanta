/**
 * Minimal RFC 4180 csv reader and writer which keeps the original text of each cell,
 * so that writing back a table only changes the cells that were modified.
 */

export interface CsvRow {
    /** The unquoted values of the cells */
    values: string[];
    /** The cells exactly as they appear in the source text */
    raw: string[];
    /** Zero-based line of the start of the row in the source text */
    line: number;
}

export interface CsvTable {
    header: CsvRow;
    rows: CsvRow[];
    /** The line separator used by the source text */
    eol: string;
    /** Whether the source text ends with a line separator */
    trailingEol: boolean;
}

/**
 * Parse csv text into a table.  The first row is the header.  Empty lines are skipped.
 */
export function parseCsv(text: string): CsvTable {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const rows: CsvRow[] = [];
    let line = 0;
    let i = 0;

    while (i < text.length) {
        const rowLine = line;
        const values: string[] = [];
        const raw: string[] = [];
        let rowDone = false;

        while (!rowDone) {
            const start = i;
            let value = "";
            if (text[i] === '"') {
                i++;
                while (i < text.length) {
                    if (text[i] === '"') {
                        if (text[i + 1] === '"') {
                            value += '"';
                            i += 2;
                            continue;
                        }
                        i++;
                        break;
                    }
                    if (text[i] === "\n") {
                        line++;
                    }
                    value += text[i];
                    i++;
                }
                // Tolerate garbage between the closing quote and the separator
                while (i < text.length && text[i] !== "," && text[i] !== "\n" && text[i] !== "\r") {
                    value += text[i];
                    i++;
                }
            } else {
                while (i < text.length && text[i] !== "," && text[i] !== "\n" && text[i] !== "\r") {
                    value += text[i];
                    i++;
                }
            }
            values.push(value);
            raw.push(text.slice(start, i));

            if (text[i] === ",") {
                i++;
            } else {
                if (text[i] === "\r") {
                    i++;
                }
                if (text[i] === "\n") {
                    i++;
                }
                line++;
                rowDone = true;
            }
        }

        if (values.length === 1 && values[0] === "") {
            continue;
        }
        rows.push({ values, raw, line: rowLine });
    }

    const header = rows.shift() ?? { values: [], raw: [], line: 0 };
    return { header, rows, eol, trailingEol: text.endsWith("\n") };
}

/**
 * Quote a value when the csv syntax requires it.
 */
export function formatCell(value: string): string {
    if (/[",\r\n]/.test(value)) {
        return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
}

function formatRow(row: CsvRow, width: number): string {
    const cells: string[] = [];
    for (let i = 0; i < width; i++) {
        const value = row.values[i] ?? "";
        const raw = row.raw[i];
        cells.push(raw !== undefined && unquote(raw) === value ? raw : formatCell(value));
    }
    return cells.join(",");
}

function unquote(raw: string): string {
    if (raw.startsWith('"')) {
        const end = raw.lastIndexOf('"');
        return raw.slice(1, end > 0 ? end : raw.length).replace(/""/g, '"') + (end > 0 ? raw.slice(end + 1) : "");
    }
    return raw;
}

/**
 * Write a table back to text.  Unchanged cells keep their original text.
 */
export function writeCsv(table: CsvTable): string {
    const width = table.header.values.length;
    const lines = [formatRow(table.header, width), ...table.rows.map((r) => formatRow(r, width))];
    return lines.join(table.eol) + (table.trailingEol ? table.eol : "");
}

/**
 * Get the value of a named column of a row, or the empty string when the column doesn't exist.
 */
export function cell(table: CsvTable, row: CsvRow, column: string): string {
    const index = table.header.values.indexOf(column);
    return index < 0 ? "" : (row.values[index] ?? "");
}
