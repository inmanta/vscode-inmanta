import { AnnotationKey, annotationHint, annotationKey, annotationKeys, AnnotationTarget } from "../lifecycle/annotations";
import { ConsoleAction, consoleView } from "../lifecycle/console";
import { EDGE_KINDS, EdgeKind, Graph, GraphEdge, View, buildGraph, stageOf } from "../lifecycle/graph";
import { expand, LsmLifecycle, LsmState } from "../lifecycle/expand";
import { Issue, lint } from "../lifecycle/lint";
import { Metadata, MetadataError, metadataIssues, MetadataTexts, parseMetadata, Scenario, StageDefinition, TRANSFER_ANNOTATION_TRIGGERS } from "../lifecycle/metadata";
import {
    ATTRIBUTE_SETS,
    formatTransfer,
    isAnnotation,
    isFlagColumn,
    LABELS,
    LifecycleFile,
    parseLifecycleCsv,
    parseStatesCsv,
    parseTransfer,
    RESOURCE_TRIGGERS,
    StatesFile,
    Trigger,
    TRIGGERS,
    XState,
} from "../lifecycle/model";
import { CompileContext, compileContexts, EventOption, eventLabel, formatEvent, Instance, parseEvent, runScenario, ScenarioResult, SimEvent, Simulator, Step } from "../lifecycle/simulator";
import { add, clear, h } from "./dom";
import { GraphSelection, GraphView } from "./graphView";
import { faIcon, ICON_NAMES } from "./icons";
import { addStage, deleteStage, moveToStage, renameStage } from "../lifecycle/stages";
import { FileChange } from "../lifecycle/edit";
import { CellChange, checkCell, lifecycleTable, planChanges, statesTable, suggestCell, TableContext, TableModel, TableTab, transfersTable } from "../lifecycle/table";
import { Grid } from "./grid";
import { attachSuggestions } from "./suggest";
import css from "./studio.css";
import redHatDisplay from "@fontsource-variable/red-hat-display/files/red-hat-display-latin-wght-normal.woff2";
import redHatText from "@fontsource-variable/red-hat-text/files/red-hat-text-latin-wght-normal.woff2";

interface VsCodeApi {
    postMessage(message: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

type Mode = "view" | "edit" | "simulate" | "table";

interface Data {
    files: { csv: string; states: string | null } & MetadataTexts;
    csvText: string;
    lifecycle: LifecycleFile;
    states?: StatesFile;
    metadata: Metadata;
    metadataErrors: MetadataError[];
    lsm: LsmLifecycle;
    issues: Issue[];
}

interface Ui {
    mode: Mode;
    view: View;
    hidden: EdgeKind[];
    search: string;
    selection: GraphSelection;
    problemsOpen: boolean;
    context: CompileContext["kind"];
    /** Widths of the side panels set by dragging their edge, the default when unset */
    leftWidth?: number;
    rightWidth?: number;
    tableTab: TableTab;
    /** Annotation columns added in Table mode that have no value yet, per tab */
    tableColumns: Partial<Record<TableTab, string[]>>;
}

interface Sim {
    start: string | null;
    instance: Instance | null;
    steps: Step[];
    history: (Instance | null)[];
}

const KIND_LABEL: Record<EdgeKind, string> = {
    create: "create",
    auto: "auto",
    update: "update",
    delete: "delete",
    set: "set state",
    deployed: "deployed",
    failed: "failed",
    non_compliant: "non-compliant",
    validated: "validated",
    rejected: "rejected",
};

const TRIGGER_LABEL: Record<Trigger, string> = {
    on_create: "create",
    on_update: "update",
    on_delete: "delete",
    on_api_set_state: "set state",
    on_auto: "auto",
    on_deployed: "deployed",
    on_failed: "failed",
    on_non_compliant: "non-compliant",
};

const keySuggestions = (on: AnnotationTarget) => annotationKeys(on).map((a) => ({ value: a.key, detail: a.description }));
const iconSuggestions = () => ICON_NAMES.map((value) => ({ value }));

const saved = (vscode.getState() ?? {}) as Partial<Ui>;
const ui: Ui = {
    mode: saved.mode ?? "view",
    view: saved.view ?? "csv",
    hidden: saved.hidden ?? [],
    search: "",
    selection: saved.selection ?? null,
    problemsOpen: saved.problemsOpen ?? false,
    context: saved.context ?? "export",
    leftWidth: saved.leftWidth,
    rightWidth: saved.rightWidth,
    tableTab: saved.tableTab ?? "lifecycle",
    tableColumns: saved.tableColumns ?? {},
};
let data: Data | null = null;
let sim: Sim = { start: null, instance: null, steps: [], history: [] };
let scenarioResults = new Map<string, ScenarioResult>();
let pendingDelete: string | null = null;
/** Web console preview: the advanced disclosure and the confirmation dialog that is open */
const consoleUi: { advanced: boolean; confirm: { title: string; body: string; event: SimEvent } | null } = { advanced: false, confirm: null };
let currentGraph: Graph | null = null;

function post(message: unknown): void {
    vscode.postMessage(message);
}

function persist(): void {
    const { search: _search, ...rest } = ui;
    vscode.setState(rest);
}

// ---------- layout ----------

const style = document.createElement("style");
// The fonts of PatternFly, for the web console preview
style.textContent = `@font-face { font-family: "RedHatTextVF"; src: url(${redHatText}) format("woff2"); font-weight: 300 700; }
@font-face { font-family: "RedHatDisplayVF"; src: url(${redHatDisplay}) format("woff2"); font-weight: 300 900; }
${css}`;
document.head.appendChild(style);

const app = document.getElementById("app")!;
const toolbar = h("div", { class: "toolbar" });
const left = h("aside", { class: "panel left" });
const canvas = h("div", { class: "canvas" });
const tableHost = h("div", { class: "table-host" });
const inspector = h("aside", { class: "panel inspector" });
const problems = h("div", { class: "problems" });
const popup = h("div", { class: "popup", hidden: true });
const leftSplit = h("div", { class: "splitter left-split", title: "Drag to resize, double click to reset" });
const rightSplit = h("div", { class: "splitter right-split", title: "Drag to resize, double click to reset" });
const main = h("div", { class: "main" }, left, canvas, tableHost, inspector, leftSplit, rightSplit);
app.append(toolbar, main, problems, popup);

function applyWidths(): void {
    for (const [name, width] of [["--left-w", ui.leftWidth], ["--right-w", ui.rightWidth]] as const) {
        if (width === undefined) {
            app.style.removeProperty(name);
        } else {
            app.style.setProperty(name, `${width}px`);
        }
    }
}

/** Resize a side panel by dragging its edge */
function bindSplitter(splitter: HTMLElement, side: "leftWidth" | "rightWidth"): void {
    let dragging = false;
    splitter.addEventListener("pointerdown", (e) => {
        dragging = true;
        splitter.setPointerCapture(e.pointerId);
        splitter.classList.add("active");
    });
    splitter.addEventListener("pointermove", (e) => {
        if (!dragging) {
            return;
        }
        const rect = main.getBoundingClientRect();
        const width = side === "leftWidth" ? e.clientX - rect.left : rect.right - e.clientX;
        ui[side] = Math.round(Math.min(Math.max(width, 160), rect.width * 0.6));
        applyWidths();
    });
    splitter.addEventListener("pointerup", () => {
        dragging = false;
        splitter.classList.remove("active");
        persist();
    });
    splitter.addEventListener("dblclick", () => {
        ui[side] = undefined;
        applyWidths();
        persist();
    });
}
bindSplitter(leftSplit, "leftWidth");
bindSplitter(rightSplit, "rightWidth");
applyWidths();

const zoomControls = h("div", { class: "zoom" },
    h("button", { title: "Zoom in", onclick: () => graphView.zoom(1.25) }, "+"),
    h("button", { title: "Zoom out", onclick: () => graphView.zoom(0.8) }, "−"),
    h("button", { title: "Fit", onclick: () => graphView.fit() }, "Fit"));
canvas.appendChild(zoomControls);

const graphView = new GraphView(canvas, {
    select: (selection) => {
        ui.selection = selection;
        pendingDelete = null;
        consoleUi.confirm = null;
        hidePopup();
        persist();
        renderAll(false);
    },
    move: (positions) => post({ type: "metadata", op: { kind: "setLayout", positions } }),
    connect: (source, target, x, y) => showConnectMenu(source, target, x, y),
    restage: (id, stage) => changeFiles(() => moveToStage(data!.lifecycle, data!.states, id, stage)),
    activate: (id) => {
        const line = data?.lifecycle.states.find((s) => s.name === csvStateOf(id))?.line;
        if (line !== undefined) {
            post({ type: "open", file: "csv", line });
        }
    },
});

// ---------- data ----------

function load(message: { csv: string; states: string | null; metadata: MetadataTexts; files: Data["files"] }): void {
    const states = message.states !== null ? parseStatesCsv(message.states) : undefined;
    const lifecycle = parseLifecycleCsv(message.csv, states);
    const parsed = parseMetadata(message.metadata);
    const lsm = expand(lifecycle.states);
    data = {
        files: message.files,
        csvText: message.csv,
        lifecycle,
        states,
        metadata: parsed.metadata,
        metadataErrors: [...parsed.errors, ...metadataIssues(parsed.metadata, lifecycle.states).map((message): MetadataError => ({ file: "transfers", message }))],
        lsm,
        issues: lint(lifecycle, states, lsm),
    };
    scenarioResults = new Map(parsed.metadata.scenarios.map((s) => [s.name, runScenario(lsm, s)]));
    // Replay the simulation on the new lifecycle, it may have changed
    if (sim.steps.length > 0 || sim.start) {
        replay(sim.start, sim.steps.map((s) => s.event));
    }
    const graph = graphFor(ui.view);
    if (ui.selection?.type === "node" && !graph.nodes.some((n) => n.id === ui.selection!.id)) {
        ui.selection = null;
    }
    if (ui.selection?.type === "stage" && !graph.stages.some((s) => s.id === ui.selection!.id)) {
        ui.selection = null;
    }
    renderAll(true);
}

window.addEventListener("message", (event) => {
    const message = event.data;
    if (message?.type === "load") {
        load(message);
    }
});

function graphFor(view: View): Graph {
    return buildGraph(view, data!.lifecycle.states, data!.lsm, data!.metadata);
}

/** The csv state a graph node stands for */
function csvStateOf(id: string): string {
    const state = data?.lsm.states.get(id);
    if (state && state.origin.kind !== "csv") {
        return state.origin.source;
    }
    return id;
}

/** The node of the current view that shows an lsm state */
function nodeOf(lsmState: string): string {
    const state = data!.lsm.states.get(lsmState);
    if (ui.view === "lsm" || !state) {
        return lsmState;
    }
    const csvName = state.origin.kind === "csv" ? lsmState : state.origin.source;
    if (ui.view === "csv") {
        return csvName;
    }
    return data!.lifecycle.states.find((x) => x.name === csvName)?.desiredState ?? csvName;
}

// ---------- simulation ----------

function simulator(): Simulator {
    return new Simulator(data!.lsm);
}

function replay(start: string | null, events: SimEvent[]): void {
    const s = simulator();
    sim = { start, instance: start ? s.instanceIn(start) : null, steps: [], history: [] };
    for (const event of events) {
        record(s, event);
    }
}

/** Apply an event, a rejected event stays in the trace but doesn't change the instance */
function record(s: Simulator, event: SimEvent): void {
    const step = s.apply(sim.instance, event);
    sim.history.push(sim.instance);
    sim.steps.push(step);
    if (!step.rejected) {
        sim.instance = step.instance;
    }
}

function send(event: SimEvent): void {
    record(simulator(), event);
    renderAll(false);
}

function stepBack(): void {
    if (sim.steps.length === 0) {
        return;
    }
    sim.steps.pop();
    sim.instance = sim.history.pop() ?? null;
    renderAll(false);
}

function trail(): string[] {
    const states: string[] = [];
    if (sim.start) {
        states.push(sim.start);
    }
    for (const step of sim.steps) {
        if (step.rejected) {
            continue;
        }
        if (step.event.kind === "create" && step.hops.length === 0) {
            states.push(step.instance.state);
        }
        for (const hop of step.hops) {
            if (states.length === 0) {
                states.push(hop.from);
            }
            states.push(hop.to);
        }
    }
    return states.map(nodeOf).filter((id, i, all) => i === 0 || all[i - 1] !== id);
}

// ---------- rendering ----------

function renderAll(dataChanged: boolean): void {
    if (data === null) {
        return;
    }
    app.dataset.mode = ui.mode;
    const focused = document.activeElement?.getAttribute("data-key");
    renderToolbar();
    if (ui.mode === "table") {
        renderTable();
    } else {
        renderGraph(dataChanged);
    }
    renderLeft();
    renderInspector();
    renderProblems();
    if (focused) {
        (document.querySelector(`[data-key="${CSS.escape(focused)}"]`) as HTMLElement | null)?.focus();
    }
}

function seg<T extends string>(options: [T, string, string?][], value: T, onChange: (v: T) => void, label?: string): HTMLElement {
    const group = h("div", { class: "seg", role: "radiogroup", "aria-label": label ?? "" },
        options.map(([v, text, title]) => h("button", { class: v === value ? "on" : "", role: "radio", "aria-checked": String(v === value), title: title ?? "", onclick: () => onChange(v) }, text)));
    return label ? h("div", { class: "seg-group" }, h("span", { class: "seg-label" }, label), group) : group;
}

function renderToolbar(): void {
    clear(toolbar);
    const d = data!;
    const csvCount = d.lifecycle.states.length;
    const desiredCount = new Set(d.lifecycle.states.map((x) => x.desiredState)).size;
    add(toolbar, 
        seg<Mode>([["view", "View"], ["edit", "Edit"], ["simulate", "Simulate"], ["table", "Table", "The csv files as tables, with suggestions and checks per column"]], ui.mode, (mode) => {
            ui.mode = mode;
            if (mode === "edit" && ui.view !== "csv") {
                ui.view = "csv";
            }
            persist();
            renderAll(false);
        }),
        ui.mode === "table" ? tableToolbar() : null,
        ui.mode === "table" ? null : seg<View>([
            ["desired", `Desired states (${desiredCount})`, "One box per desired state: what the model builds. The states with the same desired_state are merged."],
            ["csv", `States (${csvCount})`, `The states as written in ${d.files.csv}, one per row.`],
            ["lsm", `States + validation (${d.lsm.states.size})`, "Every state of the lifecycle in the orchestrator, including the validating_* and rejected_* states the factory generates for validate() transfers."],
        ], ui.view, (view) => {
            ui.view = view;
            ui.selection = null;
            persist();
            renderAll(false);
        }, "Detail"),
        ui.mode === "table" ? null : h("div", { class: "chips" },
            EDGE_KINDS.filter((k) => ui.view === "lsm" || (k !== "validated" && k !== "rejected")).map((kind) =>
                h("button", {
                    class: `chip${ui.hidden.includes(kind) ? " off" : ""}`,
                    title: ui.hidden.includes(kind) ? `Show ${KIND_LABEL[kind]} transfers` : `Hide ${KIND_LABEL[kind]} transfers`,
                    "aria-pressed": String(!ui.hidden.includes(kind)),
                    onclick: () => {
                        ui.hidden = ui.hidden.includes(kind) ? ui.hidden.filter((k) => k !== kind) : [...ui.hidden, kind];
                        persist();
                        renderAll(false);
                    },
                }, h("i", { class: `swatch k-${kind}` }), KIND_LABEL[kind]))),
        ui.mode === "table" ? null : h("input", {
            class: "search",
            type: "search",
            placeholder: "Search states",
            value: ui.search,
            "data-key": "search",
            oninput: (e: Event) => {
                ui.search = (e.target as HTMLInputElement).value;
                renderGraph(false);
            },
            onkeydown: (e: Event) => {
                if ((e as KeyboardEvent).key === "Enter" && currentGraph) {
                    const q = ui.search.toLowerCase();
                    const match = currentGraph.nodes.find((n) => n.id.includes(q) || n.title.toLowerCase().includes(q));
                    if (match) {
                        ui.selection = { type: "node", id: match.id };
                        graphView.reveal(match.id);
                        renderAll(false);
                    }
                }
            },
        }),
        ui.mode === "edit" ? addStateForm() : null,
        h("div", { class: "files" },
            h("button", { class: "link", onclick: () => post({ type: "open", file: "csv" }) }, d.files.csv),
            d.files.states ? h("button", { class: "link", onclick: () => post({ type: "open", file: "states" }) }, d.files.states) : h("span", { class: "muted", title: `Put a states.csv next to the lifecycle, or set states_csv in ${d.files.studio}` }, "no states.csv"),
            (["transfers", "stages", "studio"] as const).map((file) => h("button", { class: "link", onclick: () => post({ type: "open", file }) }, d.files[file]))),
    );
}

function addStateForm(): HTMLElement {
    const input = h("input", { class: "small", placeholder: "new_state", "data-key": "new-state", pattern: "[a-z_]+" });
    const add = () => {
        const name = input.value.trim();
        if (!name) {
            return;
        }
        const selected = ui.selection?.type === "node" ? data!.lifecycle.states.find((s) => s.name === csvStateOf(ui.selection!.id)) : undefined;
        post({
            type: "edit",
            op: { kind: "addState", name, desiredState: selected?.desiredState ?? data!.states?.options[0]?.name ?? name, after: selected?.name },
        });
        ui.selection = { type: "node", id: name };
        input.value = "";
    };
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            add();
        }
    });
    return h("div", { class: "add-state" }, input, h("button", { onclick: add }, "+ State"));
}

function renderGraph(dataChanged: boolean): void {
    const d = data!;
    const graph = graphFor(ui.view);
    currentGraph = graph;
    const key = `${ui.view}|${graph.nodes.map((n) => n.id + ":" + n.stage).join(",")}|${graph.edges.map((e) => e.id).join(",")}|${JSON.stringify(d.metadata.stages)}`;
    const problems = new Map<string, "error" | "warning" | "info">();
    for (const issue of d.issues) {
        if (issue.state) {
            const node = ui.view === "desired" ? d.lifecycle.states.find((s) => s.name === issue.state)?.desiredState ?? issue.state : issue.state;
            if (problems.get(node) !== "error") {
                problems.set(node, issue.severity === "info" && problems.has(node) ? problems.get(node)! : issue.severity);
            }
        }
    }
    let next = new Set<string>();
    let current: string | null = null;
    if (ui.mode === "simulate" && sim.instance) {
        current = nodeOf(sim.instance.state);
        next = new Set(
            d.lsm.transfers
                .filter((t) => t.source === sim.instance!.state)
                .flatMap((t) => [t.target, t.error, t.nonCompliant])
                .filter((x): x is string => x !== null)
                .map(nodeOf),
        );
    }
    graphView.setStyle({
        selection: ui.selection,
        search: ui.search,
        hidden: new Set(ui.hidden),
        editable: ui.mode === "edit" && ui.view === "csv",
        trail: ui.mode === "simulate" ? trail() : [],
        current,
        next,
        problems,
    });
    if (dataChanged || graphViewKey !== key) {
        graphViewKey = key;
        void graphView.setGraph(graph, key, ui.view === "csv" ? d.metadata.layout : {}, d.metadata.stages);
    }
}
let graphViewKey = "";

// ---------- inspector ----------

function section(title: string, ...children: (Node | string | null | false | undefined | (Node | null)[])[]): HTMLElement {
    return h("section", null, h("h3", null, title), ...children.flat());
}

function badge(label: string | null, text: string): HTMLElement {
    return h("span", { class: `badge l-${label ?? "none"}` }, text);
}

function kv(rows: [string, Node | string | null][]): HTMLElement {
    return h("dl", { class: "kv" }, rows.flatMap(([k, v]) => [h("dt", null, k), h("dd", null, v ?? "-")]));
}

function stateLink(name: string): HTMLElement {
    return h("button", {
        class: "link mono",
        onclick: () => {
            const id = nodeOf(name);
            ui.selection = { type: "node", id };
            graphView.reveal(id);
            renderAll(false);
        },
    }, name);
}

function renderInspector(): void {
    clear(inspector);
    const d = data!;
    if (ui.mode === "simulate") {
        add(inspector, ...simulationInspector());
        return;
    }
    const selection = ui.selection;
    if (ui.mode === "table") {
        const name = selection?.type === "node" ? selection.id : null;
        const x = d.lifecycle.states.find((s) => s.name === name);
        if (ui.tableTab === "lifecycle" && x) {
            add(inspector, ...editInspector(x));
        } else if (ui.tableTab === "states" && name && d.states?.options.some((o) => o.name === name)) {
            add(inspector, ...desiredStateInspector(name));
        } else {
            add(inspector, ...overview());
        }
        return;
    }
    if (selection?.type === "edge") {
        const edge = currentGraph?.edges.find((e) => e.id === selection.id);
        if (edge) {
            add(inspector, ...edgeInspector(edge));
            return;
        }
    }
    if (selection?.type === "stage") {
        add(inspector, ...stageInspector(selection.id));
        return;
    }
    if (selection?.type === "node") {
        if (ui.view === "desired") {
            add(inspector, ...desiredStateInspector(selection.id));
            return;
        }
        const state = d.lsm.states.get(selection.id);
        const x = d.lifecycle.states.find((s) => s.name === selection.id);
        if (ui.mode === "edit" && x) {
            add(inspector, ...editInspector(x));
            return;
        }
        if (state) {
            add(inspector, ...stateInspector(state));
            return;
        }
    }
    add(inspector, ...overview());
}

/**
 * The state badge and Actions menu the web console shows for an instance in this state.
 * In simulate mode, confirming an action sends it to the simulation.
 */
function consolePreview(stateName: string): HTMLElement {
    const d = data!;
    const view = consoleView(d.lsm, d.metadata, stateName, "my-instance", d.files.csv.replace(/\.csv$/, ""));
    const interactive = ui.mode === "simulate" && sim.instance?.state === stateName;
    const badge = view.badge;
    const badgeEl = badge.plain
        ? h("span", { class: "pf-plain" }, badge.text)
        : h("span", { class: `pf-label s-${badge.label ?? "none"}`, title: badge.description ?? "" }, faIcon(badge.icon), badge.text);

    const ask = (title: string, body: string, event: SimEvent) => {
        consoleUi.confirm = { title, body, event };
        renderInspector();
    };
    const item = (label: string, opts: { disabled?: boolean; icon?: string | null; variant?: string | null; onclick?: () => void; title?: string }) =>
        h("li", null, h("button", {
            class: `pf-item${opts.variant ? ` v-${opts.variant}` : ""}`,
            disabled: opts.disabled ?? false,
            title: opts.title ?? "",
            onclick: opts.onclick,
        }, faIcon(opts.icon ?? null) ?? h("span", { class: "pf-icon" }), label));
    const action = (a: ConsoleAction) =>
        item(a.label, {
            icon: a.icon,
            variant: a.variant,
            title: `api_set_state → ${a.target}${a.transfer.targetOperation ? ` (${a.transfer.targetOperation})` : ""}`,
            onclick: () => ask("Confirm set state transfer", a.confirm, { kind: "set_state", target: a.target }),
        });

    const menu = h("ul", { class: "pf-menu", role: "menu" },
        item("Edit", { disabled: !view.edit.enabled, icon: "FaWrench", title: view.edit.enabled ? "on_update transfer" : "No on_update transfer from this state" }),
        item("Duplicate", { icon: null }),
        item("Delete", {
            disabled: !view.delete.enabled,
            icon: "FaTrash",
            title: view.delete.enabled ? "on_delete transfer" : "No on_delete transfer from this state",
            onclick: () => ask("Delete instance", view.delete.confirm, { kind: "delete" }),
        }),
        view.setState.length + view.advanced.length > 0 ? h("li", { class: "pf-divider" }) : null,
        view.setState.length ? h("li", { class: "pf-group" }, "Set state") : null,
        view.setState.map(action),
        view.advanced.length
            ? h("li", null, h("button", { class: "pf-item", onclick: () => { consoleUi.advanced = !consoleUi.advanced; renderInspector(); } },
                faIcon(consoleUi.advanced ? "FaAngleDown" : "FaAngleRight"), "Advanced"))
            : null,
        consoleUi.advanced ? view.advanced.map(action) : null);

    const confirm = consoleUi.confirm;
    return h("div", { class: "pf" },
        h("div", { class: "pf-crumb" }, `Service inventory / ${d.files.csv.replace(/\.csv$/, "")} / my-instance`),
        h("div", { class: "pf-head" }, h("span", { class: "pf-title" }, "my-instance"), badgeEl, h("span", { class: "pf-toggle" }, "Actions ", faIcon("FaAngleDown"))),
        badge.description ? h("div", { class: "pf-tooltip" }, h("span", null, "Tooltip: "), badge.description) : null,
        menu,
        confirm
            ? h("div", { class: "pf-modal", role: "dialog" },
                h("div", { class: "pf-modal-title" }, h("span", { class: "pf-warn" }, faIcon("FaExclamationTriangle")), confirm.title),
                h("p", null, confirm.body),
                h("div", { class: "pf-modal-actions" },
                    h("button", {
                        class: "pf-primary",
                        onclick: () => {
                            const event = confirm.event;
                            consoleUi.confirm = null;
                            if (interactive) {
                                send(event);
                            } else {
                                renderInspector();
                            }
                        },
                    }, "Yes"),
                    h("button", { class: "pf-link", onclick: () => { consoleUi.confirm = null; renderInspector(); } }, "No")),
                interactive ? null : h("p", { class: "pf-hint" }, "In Simulate mode, Yes sends this event to the simulated instance."))
            : null);
}

function overview(): HTMLElement[] {
    const d = data!;
    const initial = [d.lsm.initialState, ...d.lsm.alternativeInitialStates].filter((s): s is string => s !== null);
    const generated = [...d.lsm.states.values()].filter((s) => s.origin.kind !== "csv").length;
    const stages = currentGraph?.stages ?? [];
    return [
        section("Lifecycle",
            kv([
                ["desired states", String(d.states?.options.length ?? new Set(d.lifecycle.states.map((s) => s.desiredState)).size)],
                ["states", String(d.lifecycle.states.length)],
                ["+ validation", `${d.lsm.states.size} states (${generated} generated by the factory)`],
                ["transfers", `${d.lsm.transfers.length} in the orchestrator`],
                ["initial", h("span", null, initial.map((s, i) => [i > 0 ? ", " : "", stateLink(s)]))],
            ])),
        section("Stages",
            h("p", { class: "muted" }, d.metadata.stages.length ? `From ${d.files.stages} and the web_stage annotations.` : "No web_stage annotations, states are grouped by desired state."),
            h("ul", { class: "plain" }, stages.map((s) => h("li", null, stageLink(s.id, s.name), s.description ? h("span", { class: "muted" }, ` - ${s.description}`) : null)))),
        section("How to use",
            h("ul", { class: "plain muted" },
                h("li", null, "Click a state or transfer to inspect it, double click a state to open its csv row."),
                h("li", null, "Edit: change a state in the inspector, drag the handle of the selected state onto another state to add a transfer, drag states to arrange them."),
                h("li", null, "Stages: in Edit, drop a state on a stage to move it there, drag a stage by its title, click a title to rename or delete the stage."),
                h("li", null, "Simulate: create an instance or start from any state, then send events."))),
    ];
}

function optionsTable(desiredState: string | null): HTMLElement | null {
    const states = data!.states;
    if (!states || !desiredState) {
        return null;
    }
    const option = states.options.find((o) => o.name === desiredState);
    if (!option) {
        return h("p", { class: "error" }, `${desiredState} is not in ${data!.files.states}`);
    }
    return h("div", { class: "flags" },
        states.columns.map((column) => {
            const value = option.columns[column];
            const flag = isFlagColumn(states, column);
            return h("div", { class: "flag" }, h("span", null, column),
                flag ? h("span", { class: value.toLowerCase() === "true" ? "on" : "off" }, value.toLowerCase() === "true" ? "on" : "off") : h("span", { class: "value" }, value || "-"));
        }),
        h("div", { class: "flag" }, h("span", null, "created_child"), h("span", { class: "value" }, option.createdChild ?? "not allowed")),
        h("div", { class: "flag" }, h("span", null, "removed_child"), h("span", { class: "value" }, option.removedChild ?? "not allowed")));
}

function stateInspector(state: LsmState): HTMLElement[] {
    const d = data!;
    const x = state.origin.kind === "csv" ? state.origin.xState : null;
    const incoming = d.lsm.transfers.filter((t) => [t.target, t.error, t.nonCompliant].includes(state.name) && t.source !== state.name);
    const outgoing = d.lsm.transfers.filter((t) => t.source === state.name);
    const issues = d.issues.filter((i) => i.state === state.name);
    const result: HTMLElement[] = [
        h("header", { class: "title" },
            badge(state.label, state.name),
            state.annotations.web_label ? h("span", { class: "muted" }, state.annotations.web_label) : null),
    ];
    if (state.origin.kind !== "csv") {
        result.push(h("p", { class: "muted" }, `Generated by the factory: ${state.origin.kind} the transfer from `, stateLink(state.origin.source), " to ", stateLink(state.origin.target), "."));
    }
    result.push(
        section("State",
            kv([
                ["desired_state", state.desiredState.onExport],
                ["current", state.validateSelf],
                ["previous", state.previousAttrSetOnExport],
                ["exports", state.exportResources ? "yes" : "no"],
                ["deleted", state.deleted ? "yes" : "no"],
                ["protected", outgoing.some((t) => t.onDelete) || state.deleted ? "no" : "yes, no on_delete"],
            ]),
            x ? h("div", { class: "actions" },
                h("button", { onclick: () => post({ type: "open", file: "csv", line: x.line }) }, "Open csv row"),
                h("button", { onclick: () => { ui.mode = "simulate"; replay(state.name, []); persist(); renderAll(false); } }, "Simulate from here")) : null),
        issues.length ? section("Problems", h("ul", { class: "plain" }, issues.map((i) => h("li", { class: i.severity }, i.message)))) : h("span"),
        section("Web console", consolePreview(state.name)),
        ui.view === "csv" && x ? csvTransfers(state.name) : section("Leaves to",
            h("div", { class: "transfers" },
                outgoing.map((t) => {
                    const outcomes: [string, string | null, string | null][] = t.resourceBased
                        ? [["deployed", t.target, t.targetOperation], ["failed", t.error, t.errorOperation], ["non-compliant", t.nonCompliant, t.nonCompliantOperation]]
                        : t.validate
                            ? [["passes", t.target, t.targetOperation], ["fails", t.error, t.errorOperation]]
                            : [[t.apiSetState ? "set state" : t.onUpdate ? "update" : t.onDelete ? "delete" : "auto", t.target, t.targetOperation]];
                    return outcomes.filter(([, target]) => target !== null).map(([label, target, op]) =>
                        h("div", { class: "transfer" }, h("span", { class: "trigger" }, label), stateLink(target!), op ? h("span", { class: "op" }, op) : null));
                }))),
        section("Comes from",
            h("div", { class: "wrap" }, [...new Set(ui.view === "csv" && x ? (currentGraph?.edges ?? []).filter((e) => e.target === state.name).map((e) => e.source) : incoming.map((t) => t.source))].map((s) => stateLink(s)))),
        section(`Desired state "${state.desiredState.onExport ?? "-"}"`, optionsTable(state.desiredState.onExport) ?? h("p", { class: "muted" }, "No states csv")),
        section("Annotations",
            Object.keys(state.annotations).length
                ? kv(Object.entries(state.annotations).map(([k, v]) => [k, h("span", null, v, x && !(k in x.ownAnnotations) ? h("span", { class: "muted" }, " (states csv)") : null)]))
                : h("p", { class: "muted" }, "None")),
    );
    return result;
}

/** The transfers of a csv state as written in the csv */
function csvTransfers(name: string): HTMLElement {
    const node = currentGraph?.nodes.find((n) => n.id === name);
    const edges = (currentGraph?.edges ?? []).filter((e) => e.source === name);
    const rows = edges.flatMap((e) => e.details.map((d) => ({ d, target: e.target })));
    rows.sort((a, b) => TRIGGERS.indexOf(a.d.trigger) - TRIGGERS.indexOf(b.d.trigger));
    return section("Leaves to",
        h("div", { class: "transfers" },
            rows.map(({ d, target }) =>
                h("div", { class: "transfer" },
                    h("span", { class: "trigger", title: d.trigger }, TRIGGER_LABEL[d.trigger]),
                    h("span", null, stateLink(target), d.validate ? h("span", { class: "tag" }, "validate") : null, d.rollback ? h("span", { class: "tag" }, "rollback") : null),
                    d.operation ? h("span", { class: "op" }, d.operation) : h("span"))),
            node?.selfLoops.length ? h("div", { class: "transfer" }, h("span", { class: "trigger" }, "stays on"), h("span", { class: "muted" }, node.selfLoops.map((k) => KIND_LABEL[k]).join(", ")), h("span")) : null));
}

function desiredStateInspector(name: string): HTMLElement[] {
    const members = data!.lifecycle.states.filter((s) => s.desiredState === name);
    return [
        h("header", { class: "title" }, badge(null, name)),
        section("States", h("div", { class: "wrap" }, members.map((m) => stateLink(m.name)))),
        section("Options", optionsTable(name) ?? h("p", { class: "muted" }, "No states csv")),
    ];
}

function edgeInspector(edge: GraphEdge): HTMLElement[] {
    const d = data!;
    return [
        h("header", { class: "title" }, stateLink(edge.source), " → ", stateLink(edge.target)),
        d.lsm.states.has(edge.source) ? section(`Web console in ${edge.source}`, consolePreview(edge.source)) : h("span"),
        ...edge.details.map((detail) => {
            const target = parseTransfer(detail.raw)?.target ?? edge.target;
            const entry = d.metadata.transfers.find((t) => t.source === detail.state && t.trigger === detail.trigger && t.target === target);
            const annotations = entry?.annotations ?? {};
            const annotatable = TRANSFER_ANNOTATION_TRIGGERS.includes(detail.trigger);
            const editable = ui.mode === "edit" && ui.view === "csv" && annotatable;
            const update = (key: string, value: string | boolean) => {
                const next = { ...annotations };
                if (value === "" || value === false) {
                    delete next[key];
                } else {
                    next[key] = value;
                }
                post({ type: "metadata", op: { kind: "setTransferAnnotations", entry: { source: detail.state, trigger: detail.trigger, target, annotations: next } } });
            };
            return section(`${detail.state}.${detail.trigger}`,
                kv([
                    ["expression", h("code", null, detail.raw)],
                    ["kind", KIND_LABEL[detail.kind]],
                    ["operation", detail.operation],
                    ["validated", detail.validate ? "yes" : "no"],
                ]),
                h("h4", null, `Transfer annotations (${d.files.transfers})`),
                editable
                    ? h("div", { class: "form" },
                        [
                            ...annotationKeys("transfer"),
                            ...Object.keys(annotations).filter((key) => !annotationKey(key, "transfer")).map((key): AnnotationKey => ({ key, on: "transfer", type: "text", console: false, description: "" })),
                        ].map((a) => annotationField(a, annotations[a.key], (value) => update(a.key, value), `ta-${detail.state}-${detail.trigger}-${a.key}`)))
                    : Object.keys(annotations).length
                        ? kv(Object.entries(annotations).map(([k, v]) => [k, String(v)]))
                        : h("p", { class: "muted" }, annotatable ? "None, switch to Edit to add them." : `The factory doesn't annotate ${detail.trigger} transfers.`));
        }),
    ];
}

// ---------- edit ----------

function field(label: string, control: HTMLElement, hint?: string, help?: string): HTMLElement {
    return h("label", { class: "field" }, h("span", null, label, hint ? h("span", { class: "muted" }, ` ${hint}`) : null), control, help ? h("small", { class: "help" }, help) : null);
}

/** An input for a transfer annotation, by the type of its key */
function annotationField(a: AnnotationKey, value: string | boolean | undefined, update: (value: string | boolean) => void, dataKey: string): HTMLElement {
    const help = a.description ? annotationHint(a) : "Not a known web_* annotation";
    if (a.type === "boolean") {
        return h("div", { class: "field" },
            h("label", { class: "check" }, h("input", { type: "checkbox", checked: value === true, "data-key": dataKey, onchange: (e: Event) => update((e.target as HTMLInputElement).checked) }), a.key),
            h("small", { class: "help" }, help));
    }
    if (a.type === "choice") {
        return field(a.key, select([...a.values!], String(value ?? ""), update, dataKey), undefined, help);
    }
    const input = h("input", { value: String(value ?? ""), "data-key": dataKey, onchange: (e: Event) => update((e.target as HTMLInputElement).value) });
    if (a.type !== "icon") {
        return field(a.key, input, undefined, help);
    }
    attachSuggestions(input, iconSuggestions, update, true);
    return field(a.key, h("div", { class: "icon-field" },
        h("span", { class: "icon-preview" }, faIcon(String(value ?? "") || null)),
        input,
        h("button", { onclick: (e: Event) => showIconPicker((e as MouseEvent).clientX, (e as MouseEvent).clientY, update) }, "Choose")), undefined, help);
}

function select(options: string[], value: string, onChange: (v: string) => void, key: string, emptyLabel = "-"): HTMLSelectElement {
    const el = h("select", { "data-key": key, onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value) },
        h("option", { value: "" }, emptyLabel),
        options.map((o) => h("option", { value: o }, o)));
    if (value && !options.includes(value)) {
        el.appendChild(h("option", { value }, value));
    }
    el.value = value;
    return el;
}

function edit(op: object): void {
    post({ type: "edit", op });
}

function transferEditor(x: XState, trigger: Trigger, raw: string, index: number): HTMLElement {
    const names = data!.lifecycle.states.map((s) => s.name);
    const expr = parseTransfer(raw);
    const resource = RESOURCE_TRIGGERS.includes(trigger);
    const setValue = (value: string) => {
        const values = [...x.triggers[trigger]];
        if (index < values.length) {
            values[index] = value;
        } else {
            values.push(value);
        }
        edit({ kind: "setTransfers", state: x.name, trigger, values: values.filter((v) => v !== "") });
    };
    const key = `t-${x.name}-${trigger}-${index}`;
    if (raw && expr === null) {
        return h("div", { class: "trow" }, h("span", { class: "trigger", title: trigger }, TRIGGER_LABEL[trigger]),
            h("input", { class: "invalid", value: raw, "data-key": key, onchange: (e: Event) => setValue((e.target as HTMLInputElement).value) }));
    }
    const current = expr ?? { validate: false, rollback: false, target: "", escape: null };
    const update = (patch: Partial<typeof current>) => {
        const next = { ...current, ...patch };
        if (patch.validate) {
            next.rollback = false;
        }
        if (patch.rollback) {
            next.validate = false;
            next.escape = null;
        }
        setValue(next.target ? formatTransfer(next) : "");
    };
    return h("div", { class: "trow" },
        h("span", { class: "trigger", title: trigger }, TRIGGER_LABEL[trigger]),
        select(names, current.target, (target) => update({ target }), key),
        resource ? h("span") : h("label", { class: "tick", title: "validate()" }, h("input", { type: "checkbox", checked: current.validate, onchange: (e: Event) => update({ validate: (e.target as HTMLInputElement).checked }) }), "val"),
        resource ? h("span") : h("label", { class: "tick", title: "rollback()" }, h("input", { type: "checkbox", checked: current.rollback, onchange: (e: Event) => update({ rollback: (e.target as HTMLInputElement).checked }) }), "rb"),
        current.validate && trigger !== "on_api_set_state"
            ? select(names, current.escape ?? "", (escape) => update({ escape: escape || null }), `${key}-escape`, "cancel to source")
            : null);
}

function editInspector(x: XState): HTMLElement[] {
    const d = data!;
    const header = d.lifecycle.table.header.values;
    const desiredStates = d.states?.options.map((o) => o.name) ?? [...new Set(d.lifecycle.states.map((s) => s.desiredState))];
    const set = (column: string, value: string) => edit({ kind: "setCell", state: x.name, column, value });
    const issues = d.issues.filter((i) => i.state === x.name);
    const references = d.lifecycle.states.filter((s) => s.name !== x.name && TRIGGERS.some((t) => s.triggers[t].some((raw) => {
        const e = parseTransfer(raw);
        return e !== null && (e.target === x.name || e.escape === x.name);
    })));
    const annotationColumns = [...new Set([...header.filter(isAnnotation), "web_label", "web_icon", "web_stage", "web_description"])];
    const inherited = (column: string) => (x.annotations[column] && !(column in x.ownAnnotations) ? x.annotations[column] : "");

    const nameInput = h("input", {
        value: x.name,
        "data-key": "name",
        onchange: (e: Event) => {
            const to = (e.target as HTMLInputElement).value.trim();
            if (to && to !== x.name) {
                edit({ kind: "renameState", from: x.name, to });
                ui.selection = { type: "node", id: to };
            }
        },
    });

    return [
        h("header", { class: "title" }, badge(x.label, x.name), h("span", { class: "muted" }, `row ${x.row + 2}`)),
        issues.length ? section("Problems", h("ul", { class: "plain" }, issues.map((i) => h("li", { class: i.severity }, i.message)))) : h("span"),
        section("State",
            h("div", { class: "form grid2" },
                field("name", nameInput),
                field("label", select([...LABELS], x.label ?? "", (v) => set("label", v), "label")),
                field("desired_state", select(desiredStates, x.desiredState, (v) => set("desired_state", v), "desired_state")),
                field("current", select([...ATTRIBUTE_SETS], x.current ?? "", (v) => set("current", v), "current")),
                field("previous", select([...ATTRIBUTE_SETS], x.previous ?? "", (v) => set("previous", v), "previous")))),
        section("Web console", consolePreview(x.name)),
        section("Transfers",
            h("div", { class: "transfer-editor" },
                TRIGGERS.flatMap((trigger) => {
                    const values = x.triggers[trigger];
                    if (trigger === "on_api_set_state") {
                        return [...values.map((raw, i) => transferEditor(x, trigger, raw, i)), transferEditor(x, trigger, "", values.length)];
                    }
                    return [transferEditor(x, trigger, values[0] ?? "", 0)];
                }))),
        section("Annotations",
            h("div", { class: "form" },
                annotationColumns.map((column) => {
                    const input = h("input", {
                        value: x.ownAnnotations[column] ?? "",
                        placeholder: inherited(column) || (column === "web_stage" ? x.desiredState : ""),
                        "data-key": `a-${column}`,
                        onchange: (e: Event) => set(column, (e.target as HTMLInputElement).value),
                    });
                    if (column === "web_icon") {
                        attachSuggestions(input, iconSuggestions, (v) => set(column, v), true);
                    } else if (column === "web_stage") {
                        attachSuggestions(input, () => allStages().map((st) => ({ value: st.id, detail: st.name })), (v) => set(column, v));
                    }
                    const known = annotationKey(column, "state");
                    const control = column === "web_icon"
                        ? h("div", { class: "icon-field" },
                            h("span", { class: "icon-preview" }, faIcon(x.ownAnnotations.web_icon || inherited(column) || null)),
                            input,
                            h("button", { onclick: (e: Event) => showIconPicker((e as MouseEvent).clientX, (e as MouseEvent).clientY, (name) => set(column, name)) }, "Choose"))
                        : input;
                    return field(column, control, inherited(column) ? "(default from states csv)" : column === "web_stage" ? "(default: desired_state)" : undefined,
                        known ? annotationHint(known) : column.startsWith("web_") ? "Not a known web_* annotation" : undefined);
                }),
                addAnnotation(x, annotationColumns))),
        section("State actions",
            h("div", { class: "actions" },
                h("button", { onclick: () => edit({ kind: "addState", name: `${x.name}_copy`, desiredState: x.desiredState, after: x.name, copyFrom: x.name }) }, "Duplicate"),
                h("button", { onclick: () => post({ type: "open", file: "csv", line: x.line }) }, "Open csv row"),
                pendingDelete === x.name
                    ? h("button", { class: "danger", onclick: () => { pendingDelete = null; ui.selection = null; edit({ kind: "deleteState", name: x.name }); } },
                        references.length ? `Delete and remove ${references.length} reference${references.length > 1 ? "s" : ""}` : "Confirm delete")
                    : h("button", { onclick: () => { pendingDelete = x.name; renderAll(false); } }, "Delete")),
            references.length && pendingDelete === x.name ? h("p", { class: "muted" }, `Referenced by ${references.map((r) => r.name).join(", ")}.`) : null),
    ];
}

function addAnnotation(x: XState, shown: readonly string[]): HTMLElement {
    const key = h("input", { placeholder: "web_...", "data-key": "new-annotation-key" });
    attachSuggestions(key, () => keySuggestions("state").filter((k) => !shown.includes(k.value)), () => value.focus());
    const value = h("input", { placeholder: "value", "data-key": "new-annotation-value" });
    const add = () => {
        const column = key.value.trim();
        if (isAnnotation(column) && value.value) {
            edit({ kind: "setCell", state: x.name, column, value: value.value });
        }
    };
    value.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            add();
        }
    });
    return h("div", { class: "add-annotation" }, key, value, h("button", { onclick: add }, "Add"));
}

function hidePopup(): void {
    popup.hidden = true;
    clear(popup);
}

function showConnectMenu(source: string, target: string, x: number, y: number): void {
    const state = data!.lifecycle.states.find((s) => s.name === source);
    if (!state) {
        return;
    }
    clear(popup);
    const validate = h("input", { type: "checkbox", id: "connect-validate" });
    add(popup, 
        h("div", { class: "popup-title" }, `${source} → ${target}`),
        h("label", { class: "check" }, validate, "validate()"),
        TRIGGERS.map((trigger) => {
            const existing = state.triggers[trigger];
            const replaces = trigger !== "on_api_set_state" && existing.length > 0 ? ` (replaces ${existing[0]})` : "";
            return h("button", {
                class: "menu-item",
                onclick: () => {
                    const resource = RESOURCE_TRIGGERS.includes(trigger);
                    const value = validate.checked && !resource ? `validate(${target})` : target;
                    edit({ kind: "addTransfer", state: source, trigger, value });
                    hidePopup();
                },
            }, trigger, h("span", { class: "muted" }, replaces));
        }),
        h("button", { class: "menu-item muted", onclick: hidePopup }, "Cancel"));
    popup.style.left = `${Math.min(x, window.innerWidth - 260)}px`;
    popup.style.top = `${Math.min(y, window.innerHeight - 340)}px`;
    popup.hidden = false;
}

/** A searchable grid of the Font Awesome icons, picking one calls choose with its name */
function showIconPicker(x: number, y: number, choose: (name: string) => void): void {
    clear(popup);
    const LIMIT = 160;
    const grid = h("div", { class: "icon-grid" });
    const count = h("div", { class: "muted small" });
    const search = h("input", { placeholder: "Search icons", "data-key": "icon-search" }) as HTMLInputElement;
    const pick = (name: string) => {
        hidePopup();
        choose(name);
    };
    const fill = () => {
        const query = search.value.trim().toLowerCase();
        const matches = ICON_NAMES.filter((name) => name.toLowerCase().includes(query));
        clear(grid);
        add(grid, matches.slice(0, LIMIT).map((name) => h("button", { class: "icon-choice", title: name, onclick: () => pick(name) }, faIcon(name))));
        count.textContent = matches.length > LIMIT ? `${LIMIT} of ${matches.length} icons, refine the search` : `${matches.length} icons`;
    };
    search.addEventListener("input", fill);
    add(popup,
        h("div", { class: "popup-title" }, "web_icon"),
        search,
        grid,
        count,
        h("div", { class: "actions" },
            h("button", { onclick: () => pick("") }, "No icon"),
            h("button", { class: "muted", onclick: hidePopup }, "Cancel")));
    fill();
    popup.style.left = `${Math.max(8, Math.min(x - 340, window.innerWidth - 360))}px`;
    popup.style.top = `${Math.max(8, Math.min(y, window.innerHeight - 420))}px`;
    popup.hidden = false;
    search.focus();
}

// ---------- stages ----------

function changeFiles(plan: () => FileChange): void {
    try {
        post({ type: "batch", change: plan() });
    } catch (e) {
        post({ type: "warn", message: e instanceof Error ? e.message : String(e) });
    }
}

/** The stages of the csv states, with the empty declared ones */
function allStages(): { id: string; name: string; declared: boolean }[] {
    return buildGraph("csv", data!.lifecycle.states, data!.lsm, data!.metadata).stages;
}

/**
 * Write a stage definition.  While some stages are not declared, declare them all in their
 * current order, as the declared stages go first.
 */
function saveStage(stage: StageDefinition): void {
    const stages = allStages();
    if (stages.every((st) => st.declared)) {
        post({ type: "metadata", op: { kind: "upsertStage", stage } });
        return;
    }
    const definitions = stages.map((st): StageDefinition => (st.id === stage.id ? stage : { id: st.id, name: st.name }));
    if (!stages.some((st) => st.id === stage.id)) {
        definitions.push(stage);
    }
    post({ type: "metadata", op: { kind: "setStages", stages: definitions } });
}

function stageMembers(id: string): XState[] {
    return data!.lifecycle.states.filter((x) => stageOf(x) === id);
}

function stageLink(id: string, label?: string): HTMLElement {
    return h("button", {
        class: "link",
        onclick: () => {
            ui.selection = { type: "stage", id };
            renderAll(false);
        },
    }, label ?? id);
}

function stagesPanel(): HTMLElement {
    const d = data!;
    const stages = allStages();
    const undeclared = stages.filter((st) => !st.declared);
    const definition = (id: string) => d.metadata.stages.find((st) => st.id === id);
    const idInput = h("input", { placeholder: "new_stage", "data-key": "new-stage" });
    const addNew = () => {
        const id = idInput.value.trim();
        if (id) {
            const name = id.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());
            changeFiles(() => {
                const change = addStage(d.lifecycle, d.metadata.stages, id, name);
                // Declare the other stages too, so the new one goes last
                return undeclared.length ? { ...change, metadata: [{ kind: "setStages", stages: [...stages.map((st) => ({ id: st.id, name: st.name })), { id, name }] }] } : change;
            });
            ui.selection = { type: "stage", id };
        }
    };
    idInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            addNew();
        }
    });
    return section("Stages",
        h("ol", { class: "stage-list" },
            stages.map((st, i) => {
                const gridded = definition(st.id)?.column !== undefined;
                const movable = st.declared;
                const selected = ui.selection?.type === "stage" && ui.selection.id === st.id;
                return h("li", { class: selected ? "on" : "" },
                    h("span", { class: "order" },
                        h("button", { class: "icon", title: "Move up", disabled: !movable || i === 0, onclick: () => post({ type: "metadata", op: { kind: "moveStage", id: st.id, delta: -1 } }) }, "↑"),
                        h("button", { class: "icon", title: "Move down", disabled: !movable || i === stages.length - 1, onclick: () => post({ type: "metadata", op: { kind: "moveStage", id: st.id, delta: 1 } }) }, "↓")),
                    stageLink(st.id, st.name),
                    h("span", { class: "muted small" }, `${stageMembers(st.id).length}${gridded ? ` · col ${definition(st.id)!.column}` : ""}${st.declared ? "" : " · not declared"}`));
            })),
        undeclared.length
            ? h("div", { class: "actions" },
                h("button", {
                    title: `Write the stages to ${d.files.stages} in this order, to name and reorder them`,
                    onclick: () => post({ type: "metadata", op: { kind: "setStages", stages: stages.map((st): StageDefinition => ({ id: st.id, name: st.name })) } }),
                }, `Declare ${undeclared.length === stages.length ? "the" : `${undeclared.length} more`} stages`))
            : null,
        h("div", { class: "add-annotation" }, idInput, h("button", { onclick: addNew }, "+ Stage")),
        h("p", { class: "muted small" }, "Drop a state on a stage to move it there. Drag a stage by its title to arrange the canvas."));
}

function stageInspector(id: string): HTMLElement[] {
    const d = data!;
    const stage = allStages().find((st) => st.id === id);
    const definition: StageDefinition = d.metadata.stages.find((st) => st.id === id) ?? { id };
    const members = stageMembers(id);
    const editable = ui.mode === "edit";
    const viaStates = members.filter((x) => !x.ownAnnotations.web_stage && x.annotations.web_stage === id);
    const viaDesired = members.filter((x) => !x.annotations.web_stage);
    const update = (patch: Partial<StageDefinition>) => saveStage({ ...definition, name: definition.name ?? stage?.name, ...patch });
    const number = (value: string) => (value.trim() === "" ? undefined : Number(value));
    const result: HTMLElement[] = [
        h("header", { class: "title" }, h("span", { class: "badge l-none" }, stage?.name ?? id), h("span", { class: "muted mono" }, id)),
    ];
    if (editable) {
        result.push(section("Stage",
            h("div", { class: "form grid2" },
                field("id", h("input", {
                    value: id,
                    "data-key": "stage-id",
                    onchange: (e: Event) => {
                        const to = (e.target as HTMLInputElement).value.trim();
                        if (to && to !== id) {
                            changeFiles(() => renameStage(d.lifecycle, d.states, d.metadata.stages, id, to));
                            ui.selection = { type: "stage", id: to };
                        }
                    },
                })),
                field("name", h("input", { value: definition.name ?? stage?.name ?? "", "data-key": "stage-name", onchange: (e: Event) => update({ name: (e.target as HTMLInputElement).value }) })),
                field("column", h("input", { type: "number", min: "0", value: definition.column ?? "", "data-key": "stage-column", onchange: (e: Event) => update({ column: number((e.target as HTMLInputElement).value) }) })),
                field("row", h("input", { type: "number", min: "0", value: definition.row ?? "", "data-key": "stage-row", onchange: (e: Event) => update({ row: number((e.target as HTMLInputElement).value) }) }))),
            h("div", { class: "form" },
                field("description", h("input", { value: definition.description ?? "", "data-key": "stage-description", onchange: (e: Event) => update({ description: (e.target as HTMLInputElement).value }) }))),
            h("p", { class: "muted small" }, "Once declared, the stages go left to right in their order, a column and row put the stage on that cell instead. Renaming the id rewrites web_stage in the csv files.")));
    } else {
        result.push(section("Stage", kv([
            ["name", stage?.name ?? id],
            ["description", definition.description ?? null],
            ["grid", definition.column !== undefined ? `column ${definition.column}, row ${definition.row ?? 0}` : null],
            ["declared", stage?.declared ? `in ${d.files.stages}` : "no, only used by web_stage or a desired state"],
        ])));
    }
    result.push(section(`States (${members.length})`,
        members.length ? h("div", { class: "wrap" }, members.map((x) => stateLink(x.name))) : h("p", { class: "muted" }, editable ? "Drop states on this stage in the canvas." : "None"),
        viaStates.length ? h("p", { class: "muted small" }, `${viaStates.length} get this stage from ${d.files.states}.`) : null,
        viaDesired.length ? h("p", { class: "muted small" }, `${viaDesired.length} are here because their desired state is ${id}, they have no web_stage.`) : null));
    if (editable) {
        result.push(section("Stage actions", h("div", { class: "actions" },
            pendingDelete === `stage:${id}`
                ? h("button", { class: "danger", onclick: () => { pendingDelete = null; ui.selection = null; changeFiles(() => deleteStage(d.lifecycle, d.states, id)); } }, members.length ? `Delete, ${members.length} states go back to their default stage` : "Confirm delete")
                : h("button", { onclick: () => { pendingDelete = `stage:${id}`; renderAll(false); } }, "Delete stage"))));
    }
    return result;
}

// ---------- table ----------

const grid = new Grid(tableHost, {
    commit: (changes) => commitCells(changes),
    select: (row) => {
        ui.selection = ui.tableTab === "transfers" ? null : { type: "node", id: row };
        persist();
        renderInspector();
    },
    check: (column, value, row) => (currentTable ? checkCell(column, value, row, currentTable, tableContext()) : []),
    suggest: (column, value) => suggestCell(column, value, tableContext()),
    pickIcon: (x, y, choose) => showIconPicker(x, y, choose),
});
let currentTable: TableModel | null = null;

function tableContext(): TableContext {
    const d = data!;
    return {
        states: d.lifecycle.states.map((s) => s.name),
        desiredStates: d.states ? d.states.options.map((o) => o.name) : [...new Set(d.lifecycle.states.map((s) => s.desiredState))],
        stages: allStages().map((s) => s.id),
        icons: ICON_NAMES,
    };
}

function tableModel(tab: TableTab): TableModel | null {
    const d = data!;
    const extra = ui.tableColumns[tab] ?? [];
    switch (tab) {
        case "lifecycle":
            return lifecycleTable(d.lifecycle, d.issues, extra);
        case "states":
            return d.states ? statesTable(d.states, d.issues, extra) : null;
        case "transfers":
            return transfersTable(d.lifecycle, d.metadata, d.metadataErrors.filter((e) => e.file === "transfers").map((e) => e.message), extra);
    }
}

function renderTable(): void {
    currentTable = tableModel(ui.tableTab);
    if (currentTable === null) {
        clear(tableHost);
        add(tableHost, h("p", { class: "muted table-empty" }, "No states csv next to the lifecycle csv."));
        return;
    }
    if (!tableHost.querySelector(".grid-scroll")) {
        clear(tableHost);
        tableHost.appendChild(gridElement);
    }
    grid.setModel(currentTable, ui.selection?.type === "node" ? ui.selection.id : null);
}
const gridElement = tableHost.firstElementChild as HTMLElement;

function commitCells(changes: CellChange[]): void {
    if (currentTable === null || changes.length === 0) {
        return;
    }
    const model = currentTable;
    changeFiles(() => planChanges(model, changes, data!.lifecycle, data!.metadata));
}

function tableToolbar(): HTMLElement {
    const d = data!;
    const columnInput = h("input", { class: "small", placeholder: "web_...", "data-key": "new-column", title: "Add an annotation column, it is written with the first value" });
    attachSuggestions(columnInput, () => keySuggestions(ui.tableTab === "transfers" ? "transfer" : "state"), () => undefined);
    const addColumn = () => {
        const column = columnInput.value.trim();
        if (!/^(web|inmanta)_[a-z0-9_]+$/.test(column)) {
            post({ type: "warn", message: "An annotation column starts with web_ or inmanta_" });
            return;
        }
        ui.tableColumns = { ...ui.tableColumns, [ui.tableTab]: [...(ui.tableColumns[ui.tableTab] ?? []), column] };
        persist();
        renderAll(false);
    };
    columnInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            addColumn();
        }
    });
    return h("div", { class: "table-tools" },
        seg<TableTab>([
            ["lifecycle", d.files.csv, "The states, one per row"],
            ["states", d.files.states ?? "states.csv", "The desired states, one per row: the options the model reads and the default annotations"],
            ["transfers", d.files.transfers, "Every transfer the factory annotates, a row is written to the transfers csv once it has an annotation"],
        ], ui.tableTab, (tab) => {
            ui.tableTab = tab;
            ui.selection = null;
            persist();
            renderAll(false);
            grid.focus();
        }),
        ui.tableTab === "lifecycle" ? addStateForm() : null,
        ui.tableTab === "transfers" ? null : h("div", { class: "add-state" }, columnInput, h("button", { onclick: addColumn }, "+ Column")));
}

// ---------- simulate ----------

function renderLeft(): void {
    clear(left);
    if (ui.mode === "table") {
        return;
    }
    if (ui.mode === "edit") {
        add(left, stagesPanel());
        return;
    }
    if (ui.mode !== "simulate") {
        return;
    }
    const d = data!;
    const s = simulator();
    const startOptions = [...d.lsm.states.keys()];
    const startSelect = select(startOptions, sim.start ?? "", (v) => {
        replay(v || null, []);
        renderAll(false);
    }, "sim-start", "New instance (create)");
    const options: EventOption[] = s.options(sim.instance);
    add(left, 
        section("Instance", field("start", startSelect),
            h("div", { class: "actions" },
                h("button", { onclick: () => { replay(sim.start, []); renderAll(false); } }, "Reset"),
                h("button", { onclick: stepBack, disabled: sim.steps.length === 0 }, "Step back"))),
        section("Send an event",
            h("div", { class: "events" },
                options.map((o) => h("button", {
                    class: `event e-${o.event.kind}${o.event.kind === "resources" ? `-${o.event.outcome}` : ""}${o.event.kind === "validation" ? (o.event.ok ? "-ok" : "-failed") : ""}`,
                    disabled: !o.enabled,
                    title: o.detail,
                    onclick: () => send(o.event),
                }, h("span", null, o.label), h("small", null, o.detail))))),
        childrenSection(),
        scenariosSection(),
    );
}

function childrenSection(): HTMLElement | null {
    const d = data!;
    if (!sim.instance || !d.states) {
        return null;
    }
    const state = d.lsm.states.get(sim.instance.state);
    const context = state ? compileContexts(state).find((c) => c.kind === ui.context) : undefined;
    const option = d.states.options.find((o) => o.name === context?.desiredState);
    return section("Embedded entities",
        h("p", { class: "muted" }, `In the ${context?.title.toLowerCase() ?? ""} compile, children get:`),
        kv([
            ["unchanged", option?.name ?? null],
            ["added", option ? option.createdChild ?? "error: not allowed" : null],
            ["removed", option ? option.removedChild ?? "error: not allowed" : null],
        ]));
}

function scenariosSection(): HTMLElement {
    const d = data!;
    const name = h("input", { placeholder: "scenario name", "data-key": "scenario-name" });
    const save = () => {
        const scenarioName = name.value.trim();
        if (!scenarioName) {
            return;
        }
        const scenario: Scenario = {
            name: scenarioName,
            start: sim.start ?? undefined,
            steps: sim.steps.filter((s) => !s.rejected).map((s) => formatEvent(s.event)),
            expect: sim.instance?.state,
        };
        post({ type: "metadata", op: { kind: "upsertScenario", scenario } });
    };
    const passed = [...scenarioResults.values()].filter((r) => r.passed).length;
    return section(`Scenarios${d.metadata.scenarios.length ? ` (${passed}/${d.metadata.scenarios.length} pass)` : ""}`,
        h("ul", { class: "plain scenarios" },
            d.metadata.scenarios.map((scenario) => {
                const result = scenarioResults.get(scenario.name);
                return h("li", null,
                    h("span", { class: result?.passed ? "pass" : "fail", title: result?.failure ?? "passes" }, result?.passed ? "✓" : "✗"),
                    h("button", { class: "link", title: `${scenario.start ? `from ${scenario.start}: ` : ""}${scenario.steps.join(", ")} → ${scenario.expect ?? "?"}`, onclick: () => { replay(scenario.start ?? null, scenario.steps.map((x) => parseEvent(x)).filter((e): e is SimEvent => e !== null)); renderAll(false); } }, scenario.name),
                    h("button", { class: "link muted", title: "Delete scenario", onclick: () => post({ type: "metadata", op: { kind: "deleteScenario", name: scenario.name } }) }, "×"),
                    result && !result.passed ? h("div", { class: "error small" }, result.failure ?? "") : null);
            })),
        h("div", { class: "add-annotation" }, name, h("button", { onclick: save, disabled: sim.steps.length === 0 && !sim.start }, "Save")),
        h("p", { class: "muted small" }, "Saves the events and the current state as the expected end state."));
}

function setsView(instance: Instance): HTMLElement {
    return h("div", { class: "sets" },
        (["candidate", "active", "rollback"] as const).map((set) =>
            h("div", { class: instance.sets[set] !== null ? "filled" : "" }, h("small", null, set), instance.sets[set] !== null ? `v${instance.sets[set]}` : "-")));
}

function simulationInspector(): HTMLElement[] {
    const d = data!;
    const instance = sim.instance;
    const result: HTMLElement[] = [];
    if (!instance) {
        result.push(section("Instance", h("p", { class: "muted" }, "No instance yet. Send Create, or pick a start state.")));
    } else {
        const state = d.lsm.states.get(instance.state);
        result.push(
            h("header", { class: "title" }, badge(state?.label ?? null, instance.state), h("span", { class: "muted" }, `version ${instance.version}`)),
            section("Web console", consolePreview(instance.state)),
            section("Attribute sets", setsView(instance)),
        );
        if (state) {
            const contexts = compileContexts(state);
            const context = contexts.find((c) => c.kind === ui.context) ?? contexts[0];
            result.push(section("What the compiler sees",
                h("table", { class: "contexts" },
                    h("thead", null, h("tr", null, h("th", null, "compile"), h("th", null, "desired state"), h("th", null, "attributes"), h("th", null, "previous"))),
                    h("tbody", null, contexts.map((c) => h("tr", {
                        class: c.kind === context.kind ? "on" : "",
                        onclick: () => { ui.context = c.kind; persist(); renderAll(false); },
                    },
                    h("td", null, c.title),
                    h("td", { class: c.desiredState ? "" : "error" }, c.desiredState ?? "fails"),
                    h("td", null, c.attributes ? `${c.attributes}${instance.sets[c.attributes as "active"] ? ` (v${instance.sets[c.attributes as "active"]})` : " (empty)"}` : "-"),
                    h("td", null, c.previous ?? "-"))))),
                h("p", { class: "muted small" }, state.exportResources ? "Resources of this state are deployed." : "This state doesn't deploy resources."),
                h("h4", null, `Flags of ${context.desiredState ?? "-"} (${context.title.toLowerCase()})`),
                optionsTable(context.desiredState) ?? h("p", { class: "muted" }, context.desiredState ? "No states csv" : "No desired state in this compile")));
        }
    }
    result.push(section("Trace",
        sim.steps.length === 0 && !sim.start ? h("p", { class: "muted" }, "No events yet.") : h("ol", { class: "trace" },
            sim.start ? h("li", null, h("b", null, "start"), ` in ${sim.start}`) : null,
            sim.steps.map((step) => h("li", { class: step.rejected ? "rejected" : "" },
                h("b", null, eventLabel(step.event)),
                step.rejected ? h("span", { class: "error" }, ` rejected: ${step.rejected}`) : null,
                step.note ? h("span", { class: "muted" }, ` ${step.note}`) : null,
                step.hops.map((hop) => h("div", { class: "hop" },
                    "→ ", h("span", { class: "mono" }, hop.to),
                    hop.operation ? h("span", { class: "op" }, hop.operation) : null,
                    hop.transfer.auto && !hop.transfer.validate ? h("span", { class: "muted" }, " auto") : null,
                    !hop.sameDesiredState ? h("span", { class: "recompile", title: "The desired state changes: lsm creates a new desired state version and recompiles" }, " ↻ recompile") : null)))))));
    if (ui.selection?.type === "node") {
        const id = ui.selection.id;
        const lsmName = d.lsm.states.has(id) ? id : null;
        result.push(section("Selected", h("div", { class: "actions" }, h("span", { class: "mono" }, id),
            lsmName ? h("button", { onclick: () => { replay(lsmName, []); renderAll(false); } }, "Start here") : null)));
    }
    return result;
}

// ---------- problems ----------

function renderProblems(): void {
    clear(problems);
    const d = data!;
    const issues = [...d.issues, ...d.metadataErrors.map((e): Issue => ({ severity: "error", code: "metadata", message: `${d.files[e.file]}: ${e.message}` }))];
    const count = (s: string) => issues.filter((i) => i.severity === s).length;
    add(problems, 
        h("button", { class: "problems-toggle", onclick: () => { ui.problemsOpen = !ui.problemsOpen; persist(); renderProblems(); } },
            ui.problemsOpen ? "▾ " : "▸ ",
            h("span", { class: "error" }, `${count("error")} errors`), " · ",
            h("span", { class: "warning" }, `${count("warning")} warnings`), " · ",
            h("span", { class: "info" }, `${count("info")} info`)),
        ui.problemsOpen
            ? h("ul", { class: "problem-list" }, issues.map((issue) =>
                h("li", { class: issue.severity },
                    h("button", {
                        class: "link",
                        onclick: () => {
                            if (issue.state) {
                                const id = ui.view === "desired" ? d.lifecycle.states.find((s) => s.name === issue.state)?.desiredState ?? issue.state : issue.state;
                                ui.selection = { type: "node", id };
                                graphView.reveal(id);
                                renderAll(false);
                            }
                            if (issue.line !== undefined) {
                                post({ type: "open", file: issue.inStatesFile ? "states" : "csv", line: issue.line });
                            }
                        },
                    }, issue.line !== undefined ? `${issue.inStatesFile ? d.files.states : d.files.csv}:${issue.line + 1}` : ""),
                    " ", issue.message)))
            : null,
    );
}

document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        hidePopup();
    }
});

post({ type: "ready" });
