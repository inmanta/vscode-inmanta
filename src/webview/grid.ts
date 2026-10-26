/**
 * A spreadsheet like grid of a table model: arrow keys move, Enter or typing edits a cell with
 * suggestions and checks, copy and paste of cell blocks, Ctrl+D fills down, Delete clears.
 */
import { CellChange, CellIssue, isEditable, Suggestion, TableColumn, TableModel } from "../lifecycle/table";
import { add, clear, h } from "./dom";
import { faIcon } from "./icons";

export interface GridCallbacks {
    commit(changes: CellChange[]): void;
    select(row: string): void;
    check(column: TableColumn, value: string, row: string): CellIssue[];
    suggest(column: TableColumn, value: string): Suggestion[];
    pickIcon(x: number, y: number, choose: (name: string) => void): void;
}

interface Point {
    r: number;
    c: number;
}

interface Editing {
    point: Point;
    input: HTMLInputElement;
    suggestions: Suggestion[];
    active: number;
}

const LABEL_CLASS: Record<string, string> = { success: "l-success", info: "l-info", warning: "l-warning", danger: "l-danger" };

export class Grid {
    private model: TableModel | null = null;
    private cursor: Point = { r: 0, c: 0 };
    private anchor: Point | null = null;
    private editing: Editing | null = null;
    private readonly scroller: HTMLElement;
    private readonly floating: HTMLElement;

    constructor(private readonly container: HTMLElement, private readonly callbacks: GridCallbacks) {
        this.scroller = h("div", { class: "grid-scroll", tabindex: "0" });
        this.floating = h("div", { class: "grid-float", hidden: true });
        add(container, this.scroller);
        document.body.appendChild(this.floating);
        this.scroller.addEventListener("keydown", (e) => this.onKey(e));
        this.scroller.addEventListener("mousedown", (e) => this.onMouseDown(e));
        this.scroller.addEventListener("dblclick", (e) => {
            const point = this.pointOf(e.target);
            if (point) {
                this.startEdit(null);
            }
        });
        document.addEventListener("copy", (e) => this.onCopy(e));
        document.addEventListener("paste", (e) => this.onPaste(e));
    }

    /** Show a model, the cursor stays on the same row and column when they still exist */
    setModel(model: TableModel, selectedRow: string | null): void {
        const previous = this.model;
        const rowId = previous?.rows[this.cursor.r]?.id;
        const columnKey = previous?.columns[this.cursor.c]?.key;
        const tabChanged = previous?.tab !== model.tab;
        this.model = model;
        const target = tabChanged ? selectedRow : rowId;
        const r = model.rows.findIndex((row) => row.id === target);
        const c = model.columns.findIndex((col) => col.key === columnKey);
        this.cursor = { r: r >= 0 ? r : Math.min(this.cursor.r, model.rows.length - 1), c: c >= 0 && !tabChanged ? c : Math.min(tabChanged ? 0 : this.cursor.c, model.columns.length - 1) };
        if (tabChanged) {
            this.anchor = null;
        }
        if (this.editing === null) {
            this.render();
        }
    }

    focus(): void {
        this.scroller.focus({ preventScroll: true });
    }

    private hasFocus(): boolean {
        return this.container.contains(document.activeElement) || this.floating.contains(document.activeElement);
    }

    private range(): { r0: number; r1: number; c0: number; c1: number } {
        const a = this.anchor ?? this.cursor;
        return { r0: Math.min(a.r, this.cursor.r), r1: Math.max(a.r, this.cursor.r), c0: Math.min(a.c, this.cursor.c), c1: Math.max(a.c, this.cursor.c) };
    }

    private render(): void {
        const model = this.model;
        const scrollTop = this.scroller.scrollTop;
        const scrollLeft = this.scroller.scrollLeft;
        clear(this.scroller);
        if (model === null) {
            return;
        }
        const range = this.range();
        const groups: { name: string; span: number }[] = [];
        for (const column of model.columns) {
            const last = groups[groups.length - 1];
            if (last && last.name === column.group) {
                last.span++;
            } else {
                groups.push({ name: column.group, span: 1 });
            }
        }
        const table = h("table", { class: "grid" },
            h("thead", null,
                h("tr", { class: "groups" }, h("th", { class: "rowhead" }), groups.map((g) => h("th", { colspan: String(g.span) }, g.name))),
                h("tr", null, h("th", { class: "rowhead" }, "#"), model.columns.map((col, c) => h("th", { class: `${c === 0 ? "frozen " : ""}${isEditable(col) ? "" : "fixed"}`, title: col.hint }, col.key)))),
            h("tbody", null, model.rows.map((row, r) => {
                const issues = [...row.rowIssues, ...Object.values(row.issues).flat()];
                const worst = issues.some((i) => i.severity === "error") ? "error" : issues.some((i) => i.severity === "warning") ? "warning" : issues.length ? "info" : "";
                return h("tr", { class: r === this.cursor.r ? "current" : "" },
                    h("th", { class: `rowhead ${worst}`, title: issues.map((i) => i.message).join("\n") }, String(r + 1), worst ? h("span", { class: "marker" }, "●") : null),
                    model.columns.map((col, c) => {
                        const value = row.cells[col.key] ?? "";
                        const cellIssues = row.issues[col.key] ?? [];
                        const severity = cellIssues.some((i) => i.severity === "error") ? "error" : cellIssues.length ? cellIssues[0].severity : "";
                        const selected = r >= range.r0 && r <= range.r1 && c >= range.c0 && c <= range.c1;
                        const cursor = r === this.cursor.r && c === this.cursor.c;
                        const cls = [c === 0 ? "frozen" : "", `col-${col.kind}`, severity ? `issue-${severity}` : "", selected ? "selected" : "", cursor ? "cursor" : ""].filter(Boolean).join(" ");
                        return h("td", { class: cls, "data-r": String(r), "data-c": String(c), title: cellIssues.map((i) => i.message).join("\n") }, this.cellContent(col, value));
                    }));
            })));
        add(this.scroller, table);
        this.scroller.scrollTop = scrollTop;
        this.scroller.scrollLeft = scrollLeft;
    }

    private cellContent(column: TableColumn, value: string): Node | string {
        if (value === "") {
            return "";
        }
        if (column.kind === "label") {
            return h("span", { class: `grid-label ${LABEL_CLASS[value] ?? ""}` }, value);
        }
        if (column.kind === "icon") {
            return h("span", { class: "grid-icon" }, faIcon(value), value);
        }
        return value;
    }

    private pointOf(target: EventTarget | null): Point | null {
        const td = (target as Element | null)?.closest?.("td[data-r]");
        return td ? { r: Number(td.getAttribute("data-r")), c: Number(td.getAttribute("data-c")) } : null;
    }

    private onMouseDown(e: MouseEvent): void {
        const point = this.pointOf(e.target);
        if (!point) {
            return;
        }
        if (this.editing) {
            this.commitEdit();
        }
        e.preventDefault();
        this.anchor = e.shiftKey ? (this.anchor ?? this.cursor) : null;
        this.moveTo(point);
        this.focus();
    }

    private moveTo(point: Point): void {
        const model = this.model!;
        const r = Math.max(0, Math.min(point.r, model.rows.length - 1));
        const c = Math.max(0, Math.min(point.c, model.columns.length - 1));
        const rowChanged = r !== this.cursor.r;
        this.cursor = { r, c };
        this.render();
        this.scroller.querySelector("td.cursor")?.scrollIntoView({ block: "nearest", inline: "nearest" });
        if (rowChanged || this.anchor === null) {
            this.callbacks.select(model.rows[r].id);
        }
    }

    private onKey(e: KeyboardEvent): void {
        if (this.editing || !this.model || this.model.rows.length === 0) {
            return;
        }
        const ctrl = e.ctrlKey || e.metaKey;
        const moves: Record<string, Point> = { ArrowUp: { r: -1, c: 0 }, ArrowDown: { r: 1, c: 0 }, ArrowLeft: { r: 0, c: -1 }, ArrowRight: { r: 0, c: 1 } };
        if (e.key in moves) {
            e.preventDefault();
            const d = moves[e.key];
            this.anchor = e.shiftKey ? (this.anchor ?? this.cursor) : null;
            this.moveTo({ r: this.cursor.r + d.r, c: this.cursor.c + d.c });
        } else if (e.key === "Tab") {
            e.preventDefault();
            this.anchor = null;
            this.moveTo({ r: this.cursor.r, c: this.cursor.c + (e.shiftKey ? -1 : 1) });
        } else if (e.key === "Enter" || e.key === "F2") {
            e.preventDefault();
            this.startEdit(null);
        } else if (e.key === "Delete" || e.key === "Backspace") {
            e.preventDefault();
            this.fillRange(() => "");
        } else if (ctrl && e.key.toLowerCase() === "d") {
            e.preventDefault();
            const range = this.range();
            const top = this.model.rows[range.r0];
            this.fillRange((_r, c) => top.cells[this.model!.columns[c].key] ?? "", 1);
        } else if (e.key === "Escape") {
            this.anchor = null;
            this.render();
        } else if (e.key.length === 1 && !ctrl && !e.altKey) {
            e.preventDefault();
            this.startEdit(e.key);
        }
    }

    /** Set every editable cell of the selected range, skipping the first rows */
    private fillRange(value: (r: number, c: number) => string, skipRows = 0): void {
        const model = this.model!;
        const range = this.range();
        const changes: CellChange[] = [];
        for (let r = range.r0 + skipRows; r <= range.r1; r++) {
            for (let c = range.c0; c <= range.c1; c++) {
                const column = model.columns[c];
                if (isEditable(column)) {
                    changes.push({ row: model.rows[r].id, column: column.key, value: value(r, c) });
                }
            }
        }
        if (changes.length) {
            this.callbacks.commit(changes);
        }
    }

    private onCopy(e: ClipboardEvent): void {
        if (!this.model || this.editing || !this.hasFocus()) {
            return;
        }
        const range = this.range();
        const lines: string[] = [];
        for (let r = range.r0; r <= range.r1; r++) {
            const values: string[] = [];
            for (let c = range.c0; c <= range.c1; c++) {
                values.push(this.model.rows[r].cells[this.model.columns[c].key] ?? "");
            }
            lines.push(values.join("\t"));
        }
        e.clipboardData?.setData("text/plain", lines.join("\n"));
        e.preventDefault();
    }

    /** Paste tab separated values from the cursor, a single value fills the selected range */
    private onPaste(e: ClipboardEvent): void {
        if (!this.model || this.editing || !this.hasFocus()) {
            return;
        }
        const text = e.clipboardData?.getData("text/plain") ?? "";
        e.preventDefault();
        const block = text.replace(/\r?\n$/, "").split(/\r?\n/).map((line) => line.split("\t"));
        if (block.length === 1 && block[0].length === 1) {
            this.fillRange(() => block[0][0]);
            return;
        }
        const model = this.model;
        const range = this.range();
        const changes: CellChange[] = [];
        block.forEach((values, i) => {
            const row = model.rows[range.r0 + i];
            values.forEach((value, j) => {
                const column = model.columns[range.c0 + j];
                if (row && column && isEditable(column)) {
                    changes.push({ row: row.id, column: column.key, value });
                }
            });
        });
        this.callbacks.commit(changes);
    }

    private startEdit(initial: string | null): void {
        const model = this.model!;
        const column = model.columns[this.cursor.c];
        const row = model.rows[this.cursor.r];
        if (!isEditable(column)) {
            return;
        }
        const td = this.scroller.querySelector("td.cursor") as HTMLElement | null;
        if (!td) {
            return;
        }
        const input = h("input", { class: "grid-input", value: initial ?? row.cells[column.key] ?? "", spellcheck: "false" });
        this.editing = { point: { ...this.cursor }, input, suggestions: [], active: -1 };
        clear(td);
        td.classList.add("editing");
        td.appendChild(input);
        if (column.kind === "icon") {
            td.appendChild(h("button", {
                class: "grid-pick",
                title: "Choose an icon",
                onmousedown: (e: Event) => e.preventDefault(),
                onclick: (e: Event) => {
                    const point = { ...this.cursor };
                    this.cancelEdit();
                    this.callbacks.pickIcon((e as MouseEvent).clientX, (e as MouseEvent).clientY, (name) => this.callbacks.commit([{ row: model.rows[point.r].id, column: column.key, value: name }]));
                },
            }, "…"));
        }
        input.addEventListener("input", () => this.updateFloat());
        input.addEventListener("keydown", (e) => this.onEditKey(e));
        input.addEventListener("blur", () => {
            // Clicking a suggestion keeps the focus, see the mousedown handler of the list
            if (this.editing?.input === input) {
                this.commitEdit();
            }
        });
        input.focus();
        if (initial === null) {
            input.select();
        }
        this.updateFloat();
    }

    private updateFloat(): void {
        const editing = this.editing!;
        const model = this.model!;
        const column = model.columns[editing.point.c];
        const value = editing.input.value;
        editing.suggestions = this.callbacks.suggest(column, value).filter((s) => s.value !== value);
        const issues = this.callbacks.check(column, value, model.rows[editing.point.r].id);
        // Enter takes the first suggestion when the typed value isn't valid, a valid value is kept as typed
        editing.active = issues.some((i) => i.severity === "error") && editing.suggestions.length ? 0 : -1;
        editing.input.classList.toggle("invalid", issues.some((i) => i.severity === "error"));
        clear(this.floating);
        if (issues.length === 0 && editing.suggestions.length === 0) {
            this.floating.hidden = true;
            return;
        }
        add(this.floating,
            issues.map((i) => h("div", { class: `grid-check ${i.severity}` }, i.message)),
            editing.suggestions.length
                ? h("ul", { class: "grid-suggestions" }, editing.suggestions.map((s, i) => h("li", {
                    class: i === editing.active ? "active" : "",
                    onmousedown: (e: Event) => {
                        e.preventDefault();
                        this.accept(i);
                    },
                }, column.kind === "icon" ? faIcon(s.value) : null, h("span", null, s.value), s.detail ? h("small", null, s.detail) : null)))
                : null);
        const rect = editing.input.getBoundingClientRect();
        this.floating.style.left = `${rect.left}px`;
        this.floating.style.top = `${rect.bottom + 2}px`;
        this.floating.style.minWidth = `${Math.max(rect.width, 220)}px`;
        this.floating.hidden = false;
    }

    private highlight(active: number): void {
        const editing = this.editing!;
        editing.active = active;
        this.floating.querySelectorAll(".grid-suggestions li").forEach((li, i) => {
            li.classList.toggle("active", i === active);
            if (i === active) {
                li.scrollIntoView({ block: "nearest" });
            }
        });
    }

    private accept(index: number): void {
        const editing = this.editing!;
        editing.input.value = editing.suggestions[index].value;
        const column = this.model!.columns[editing.point.c];
        if (column.kind === "transfers") {
            // Keep editing to add another target
            editing.input.focus();
            this.updateFloat();
            return;
        }
        this.commitEdit();
    }

    private onEditKey(e: KeyboardEvent): void {
        const editing = this.editing!;
        const count = editing.suggestions.length;
        if (e.key === "ArrowDown" && count) {
            e.preventDefault();
            this.highlight((editing.active + 1) % count);
        } else if (e.key === "ArrowUp" && count) {
            e.preventDefault();
            this.highlight(editing.active <= 0 ? count - 1 : editing.active - 1);
        } else if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault();
            if (editing.active >= 0) {
                editing.input.value = editing.suggestions[editing.active].value;
            }
            const next = e.key === "Tab" ? { r: editing.point.r, c: editing.point.c + (e.shiftKey ? -1 : 1) } : { r: editing.point.r + (e.shiftKey ? -1 : 1), c: editing.point.c };
            this.commitEdit();
            this.anchor = null;
            this.moveTo(next);
            this.focus();
        } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            this.cancelEdit();
            this.focus();
        }
    }

    private endEdit(): Editing | null {
        const editing = this.editing;
        this.editing = null;
        this.floating.hidden = true;
        clear(this.floating);
        return editing;
    }

    private commitEdit(): void {
        const editing = this.endEdit();
        if (editing === null) {
            return;
        }
        const model = this.model!;
        const row = model.rows[editing.point.r];
        const column = model.columns[editing.point.c];
        const value = editing.input.value;
        this.render();
        if (value !== (row.cells[column.key] ?? "")) {
            this.callbacks.commit([{ row: row.id, column: column.key, value }]);
        }
    }

    private cancelEdit(): void {
        this.endEdit();
        this.render();
    }
}
