import { EDGE_KINDS, EdgeKind, Graph, GraphEdge, View, buildGraph } from "../lifecycle/graph";
import { expand, LsmLifecycle, LsmState } from "../lifecycle/expand";
import { Issue, lint } from "../lifecycle/lint";
import { emptyMetadata, Metadata, parseMetadata, Scenario } from "../lifecycle/metadata";
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
import css from "./studio.css";

interface VsCodeApi {
    postMessage(message: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

type Mode = "view" | "edit" | "simulate";

interface Data {
    files: { csv: string; states: string | null; metadata: string };
    csvText: string;
    lifecycle: LifecycleFile;
    states?: StatesFile;
    metadata: Metadata;
    metadataErrors: string[];
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

const ANNOTATION_SUGGESTIONS = ["web_label", "web_description", "web_icon", "web_stage", "web_kind"];
const TRANSFER_ANNOTATIONS = ["web_action", "web_button_label", "web_confirm", "web_button_variant"];

const saved = (vscode.getState() ?? {}) as Partial<Ui>;
const ui: Ui = {
    mode: saved.mode ?? "view",
    view: saved.view ?? "csv",
    hidden: saved.hidden ?? [],
    search: "",
    selection: saved.selection ?? null,
    problemsOpen: saved.problemsOpen ?? false,
    context: saved.context ?? "export",
};
let data: Data | null = null;
let sim: Sim = { start: null, instance: null, steps: [], history: [] };
let scenarioResults = new Map<string, ScenarioResult>();
let pendingDelete: string | null = null;
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
style.textContent = css;
document.head.appendChild(style);

const app = document.getElementById("app")!;
const toolbar = h("div", { class: "toolbar" });
const left = h("aside", { class: "panel left" });
const canvas = h("div", { class: "canvas" });
const inspector = h("aside", { class: "panel inspector" });
const problems = h("div", { class: "problems" });
const popup = h("div", { class: "popup", hidden: true });
const main = h("div", { class: "main" }, left, canvas, inspector);
app.append(toolbar, main, problems, popup);

const zoomControls = h("div", { class: "zoom" },
    h("button", { title: "Zoom in", onclick: () => graphView.zoom(1.25) }, "+"),
    h("button", { title: "Zoom out", onclick: () => graphView.zoom(0.8) }, "−"),
    h("button", { title: "Fit", onclick: () => graphView.fit() }, "Fit"));
canvas.appendChild(zoomControls);

const graphView = new GraphView(canvas, {
    select: (selection) => {
        ui.selection = selection;
        pendingDelete = null;
        hidePopup();
        persist();
        renderAll(false);
    },
    move: (positions) => post({ type: "metadata", op: { kind: "setLayout", positions } }),
    connect: (source, target, x, y) => showConnectMenu(source, target, x, y),
    activate: (id) => {
        const line = data?.lifecycle.states.find((s) => s.name === csvStateOf(id))?.line;
        if (line !== undefined) {
            post({ type: "open", file: "csv", line });
        }
    },
});

// ---------- data ----------

function load(message: { csv: string; states: string | null; metadata: string | null; files: Data["files"] }): void {
    const states = message.states !== null ? parseStatesCsv(message.states) : undefined;
    const lifecycle = parseLifecycleCsv(message.csv, states);
    const parsed = message.metadata ? parseMetadata(message.metadata) : { metadata: emptyMetadata(), errors: [] };
    const lsm = expand(lifecycle.states);
    data = {
        files: message.files,
        csvText: message.csv,
        lifecycle,
        states,
        metadata: parsed.metadata,
        metadataErrors: parsed.errors,
        lsm,
        issues: lint(lifecycle, states, lsm),
    };
    scenarioResults = new Map(parsed.metadata.scenarios.map((s) => [s.name, runScenario(lsm, s)]));
    // Replay the simulation on the new lifecycle, it may have changed
    if (sim.steps.length > 0 || sim.start) {
        replay(sim.start, sim.steps.map((s) => s.event));
    }
    if (ui.selection?.type === "node" && !graphFor(ui.view).nodes.some((n) => n.id === ui.selection!.id)) {
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
        const step = s.apply(sim.instance, event);
        if (step.rejected) {
            break;
        }
        sim.history.push(sim.instance);
        sim.steps.push(step);
        sim.instance = step.instance;
    }
}

function send(event: SimEvent): void {
    const step = simulator().apply(sim.instance, event);
    if (step.rejected) {
        sim.steps.push(step);
        sim.history.push(sim.instance);
    } else {
        sim.history.push(sim.instance);
        sim.steps.push(step);
        sim.instance = step.instance;
    }
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
    renderGraph(dataChanged);
    renderLeft();
    renderInspector();
    renderProblems();
    if (focused) {
        (document.querySelector(`[data-key="${CSS.escape(focused)}"]`) as HTMLElement | null)?.focus();
    }
}

function seg<T extends string>(options: [T, string][], value: T, onChange: (v: T) => void): HTMLElement {
    return h("div", { class: "seg", role: "radiogroup" },
        options.map(([v, label]) => h("button", { class: v === value ? "on" : "", role: "radio", "aria-checked": String(v === value), onclick: () => onChange(v) }, label)));
}

function renderToolbar(): void {
    clear(toolbar);
    const d = data!;
    const csvCount = d.lifecycle.states.length;
    add(toolbar, 
        seg<Mode>([["view", "View"], ["edit", "Edit"], ["simulate", "Simulate"]], ui.mode, (mode) => {
            ui.mode = mode;
            if (mode === "edit" && ui.view !== "csv") {
                ui.view = "csv";
            }
            persist();
            renderAll(false);
        }),
        seg<View>([["csv", `CSV states (${csvCount})`], ["lsm", `LSM states (${d.lsm.states.size})`], ["desired", "Desired states"]], ui.view, (view) => {
            ui.view = view;
            ui.selection = null;
            persist();
            renderAll(false);
        }),
        h("div", { class: "chips" },
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
        h("input", {
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
            d.files.states ? h("button", { class: "link", onclick: () => post({ type: "open", file: "states" }) }, d.files.states) : h("span", { class: "muted", title: "Put a states.csv next to the lifecycle, or set states_csv in the metadata file" }, "no states.csv"),
            h("button", { class: "link", onclick: () => post({ type: "open", file: "metadata" }) }, d.files.metadata)),
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
    if (selection?.type === "edge") {
        const edge = currentGraph?.edges.find((e) => e.id === selection.id);
        if (edge) {
            add(inspector, ...edgeInspector(edge));
            return;
        }
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

function overview(): HTMLElement[] {
    const d = data!;
    const initial = [d.lsm.initialState, ...d.lsm.alternativeInitialStates].filter((s): s is string => s !== null);
    const generated = [...d.lsm.states.values()].filter((s) => s.origin.kind !== "csv").length;
    const stages = currentGraph?.stages ?? [];
    return [
        section("Lifecycle",
            kv([
                ["csv states", String(d.lifecycle.states.length)],
                ["lsm states", `${d.lsm.states.size} (${generated} generated for validation)`],
                ["lsm transfers", String(d.lsm.transfers.length)],
                ["initial", h("span", null, initial.map((s, i) => [i > 0 ? ", " : "", stateLink(s)]))],
                ["desired states", String(d.states?.options.length ?? new Set(d.lifecycle.states.map((s) => s.desiredState)).size)],
            ])),
        section("Stages",
            h("p", { class: "muted" }, d.metadata.stages.length ? "From the metadata file and the web_stage annotations." : "No web_stage annotations, states are grouped by desired state."),
            h("ul", { class: "plain" }, stages.map((s) => h("li", null, s.name, s.description ? h("span", { class: "muted" }, ` - ${s.description}`) : null)))),
        section("How to use",
            h("ul", { class: "plain muted" },
                h("li", null, "Click a state or transfer to inspect it, double click a state to open its csv row."),
                h("li", null, "Edit: change a state in the inspector, drag the handle of the selected state onto another state to add a transfer, drag states to arrange them."),
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
        ...edge.details.map((detail) => {
            const target = parseTransfer(detail.raw)?.target ?? edge.target;
            const entry = d.metadata.transfers.find((t) => t.source === detail.state && t.trigger === detail.trigger && t.target === target);
            const annotations = entry?.annotations ?? {};
            const editable = ui.mode === "edit" && ui.view === "csv";
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
                h("h4", null, "Transfer annotations (metadata file)"),
                editable
                    ? h("div", { class: "form" },
                        TRANSFER_ANNOTATIONS.map((key) => field(key, h("input", {
                            value: String(annotations[key] ?? ""),
                            "data-key": `ta-${detail.state}-${detail.trigger}-${key}`,
                            onchange: (e: Event) => update(key, (e.target as HTMLInputElement).value),
                        }))),
                        h("label", { class: "check" }, h("input", { type: "checkbox", checked: annotations.web_flow === true, onchange: (e: Event) => update("web_flow", (e.target as HTMLInputElement).checked) }), "web_flow: part of the intended flow"),
                        h("label", { class: "check" }, h("input", { type: "checkbox", checked: annotations.web_advanced_state === true, onchange: (e: Event) => update("web_advanced_state", (e.target as HTMLInputElement).checked) }), "web_advanced_state"))
                    : Object.keys(annotations).length
                        ? kv(Object.entries(annotations).map(([k, v]) => [k, String(v)]))
                        : h("p", { class: "muted" }, "None, switch to Edit to add them."));
        }),
    ];
}

// ---------- edit ----------

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
    return h("label", { class: "field" }, h("span", null, label, hint ? h("span", { class: "muted" }, ` ${hint}`) : null), control);
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
    const annotationColumns = [...new Set([...header.filter(isAnnotation), "web_label", "web_stage", "web_description"])];
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
                annotationColumns.map((column) => field(column, h("input", {
                    value: x.ownAnnotations[column] ?? "",
                    placeholder: inherited(column) || (column === "web_stage" ? x.desiredState : ""),
                    "data-key": `a-${column}`,
                    onchange: (e: Event) => set(column, (e.target as HTMLInputElement).value),
                }), inherited(column) ? "(default from states csv)" : column === "web_stage" ? "(default: desired_state)" : undefined)),
                h("datalist", { id: "annotation-keys" }, ANNOTATION_SUGGESTIONS.map((k) => h("option", { value: k }))),
                addAnnotation(x))),
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

function addAnnotation(x: XState): HTMLElement {
    const key = h("input", { placeholder: "web_...", list: "annotation-keys", "data-key": "new-annotation-key" });
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

// ---------- simulate ----------

function renderLeft(): void {
    clear(left);
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
    const issues = [...d.issues, ...d.metadataErrors.map((m): Issue => ({ severity: "error", code: "metadata", message: `${d.files.metadata}: ${m}` }))];
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
