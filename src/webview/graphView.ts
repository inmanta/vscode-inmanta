import ELK, { ElkNode } from "elkjs/lib/elk.bundled.js";
import { EdgeKind, Graph, GraphEdge, GraphNode } from "../lifecycle/graph";
import { clear, s } from "./dom";

export type GraphSelection = { type: "node"; id: string } | { type: "edge"; id: string } | { type: "stage"; id: string } | { type: "desired"; id: string } | null;

export interface GraphStyle {
    selection: GraphSelection;
    search: string;
    hidden: ReadonlySet<EdgeKind>;
    editable: boolean;
    /** Simulation: the states visited, in order, and the current one */
    trail: string[];
    current: string | null;
    next: ReadonlySet<string>;
    /** States with problems */
    problems: ReadonlyMap<string, "error" | "warning" | "info">;
}

export interface GraphCallbacks {
    select(selection: GraphSelection): void;
    move(positions: Record<string, { x: number; y: number }>): void;
    connect(source: string, target: string, x: number, y: number): void;
    /** A state was dropped in another stage */
    restage(id: string, stage: string): void;
    activate(id: string): void;
}

interface Box {
    x: number;
    y: number;
    w: number;
    h: number;
}

function union(a: Box, b: Box): Box {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

const NODE_H = 30;
const EMPTY_STAGE = { w: 220, h: 90 };
const KIND_ORDER: EdgeKind[] = ["create", "auto", "update", "delete", "set", "validated", "rejected", "deployed", "failed", "non_compliant"];
const DASHED: ReadonlySet<EdgeKind> = new Set(["failed", "non_compliant", "rejected"]);

function nodeWidth(node: GraphNode): number {
    return Math.min(420, Math.max(130, node.id.length * 7.2 + 34));
}

// Generated states are stacked under their parent state, indented
const CHILD_INDENT = 18;
const CHILD_GAP = 8;

function primaryKind(edge: GraphEdge, hidden: ReadonlySet<EdgeKind>): EdgeKind | null {
    const kinds = edge.details.map((d) => d.kind).filter((k) => !hidden.has(k));
    return KIND_ORDER.find((k) => kinds.includes(k)) ?? null;
}

function cubicPoint(p: number[], t: number): { x: number; y: number } {
    const [x0, y0, x1, y1, x2, y2, x3, y3] = p;
    const u = 1 - t;
    return {
        x: u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
        y: u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
    };
}

/** The part of the curve from its start up to t (de Casteljau) */
function cubicHead(p: number[], t: number): number[] {
    const lerp = (a: number, b: number) => a + (b - a) * t;
    const [x0, y0, x1, y1, x2, y2, x3, y3] = p;
    const ax = lerp(x0, x1), ay = lerp(y0, y1);
    const bx = lerp(x1, x2), by = lerp(y1, y2);
    const cx = lerp(x2, x3), cy = lerp(y2, y3);
    const dx = lerp(ax, bx), dy = lerp(ay, by);
    const ex = lerp(bx, cx), ey = lerp(by, cy);
    return [x0, y0, ax, ay, dx, dy, lerp(dx, ex), lerp(dy, ey)];
}

function curvePath(p: number[]): string {
    return `M${p[0]},${p[1]} C${p[2]},${p[3]} ${p[4]},${p[5]} ${p[6]},${p[7]}`;
}

/**
 * A curve ending in an arrowhead.  The head points along the part of the curve it covers, the
 * tangent at the very end can differ a lot from that when the curve bends close to its end, and
 * the line stops at the base of the head so it doesn't show behind it.
 */
function arrow(p: number[], size: number): { line: string; head: string } {
    const tip = { x: p[6], y: p[7] };
    let t = 0.5;
    for (let candidate = 0.995; candidate > 0.5; candidate -= 0.005) {
        const q = cubicPoint(p, candidate);
        if (Math.hypot(tip.x - q.x, tip.y - q.y) >= size) {
            t = candidate;
            break;
        }
    }
    const base = cubicPoint(p, t);
    const length = Math.hypot(tip.x - base.x, tip.y - base.y) || 1;
    const ux = (tip.x - base.x) / length;
    const uy = (tip.y - base.y) / length;
    const w = size * 0.45;
    // The line goes slightly under the head, so no gap shows at the joint
    const line = cubicHead(p, Math.min(1, t + 0.003));
    return {
        line: curvePath(line),
        head: `M${tip.x},${tip.y} L${base.x - uy * w},${base.y + ux * w} L${base.x + uy * w},${base.y - ux * w} z`,
    };
}

/** A curve from box a to box b, picking the sides by where b sits */
function edgeCurve(a: Box, b: Box, offset: number): number[] {
    const ax = a.x + a.w / 2;
    const ay = a.y + a.h / 2;
    const bx = b.x + b.w / 2;
    const by = b.y + b.h / 2;
    if (b.x > a.x + a.w - 4) {
        const sx = a.x + a.w;
        const ex = b.x;
        const c = Math.max(30, (ex - sx) / 2);
        return [sx, ay + offset, sx + c, ay + offset, ex - c, by + offset, ex, by + offset];
    }
    if (b.x + b.w < a.x + 4) {
        const dip = Math.max(a.y + a.h, b.y + b.h) + 26 + Math.abs(ax - bx) * 0.06 + Math.abs(offset) * 2;
        return [ax + offset, a.y + a.h, ax + offset, dip, bx + offset, dip, bx + offset, b.y + b.h];
    }
    // Same column: bulge to the right going down, to the left going up
    const down = by > ay;
    const side = down ? a.x + a.w : a.x;
    const bside = down ? b.x + b.w : b.x;
    const bulge = (down ? 1 : -1) * (34 + Math.abs(by - ay) * 0.15);
    return [side, ay, side + bulge, ay, bside + bulge, by, bside, by];
}

export class GraphView {
    private readonly svg: SVGSVGElement;
    private readonly viewport: SVGGElement;
    private graph: Graph | null = null;
    private layoutKey = "";
    private boxes = new Map<string, Box>();
    private stageBoxes = new Map<string, Box>();
    /** The stages without states, placed by the layout */
    private emptyStageBoxes = new Map<string, Box>();
    private transform = { k: 1, x: 20, y: 20 };
    private style: GraphStyle | null = null;
    private drag: {
        kind: "pan" | "node" | "connect" | "stage";
        id?: string;
        startX: number;
        startY: number;
        moved: boolean;
        ox: number;
        oy: number;
        /** What was under the pointer when it went down, pointer capture retargets the later events */
        hit: GraphSelection;
        /** The box of the stage of the dragged state when the drag started, it doesn't shrink during the drag */
        stageBox?: Box;
    } | null = null;
    private tempLine: SVGPathElement | null = null;
    /** The stage the dragged state would be dropped in */
    private dropStage: string | null = null;
    private readonly elk = new ELK();
    private stageDefinitions = new Map<string, { column?: number; row?: number }>();
    private layoutVersion = 0;

    constructor(
        private readonly container: HTMLElement,
        private readonly callbacks: GraphCallbacks,
    ) {
        this.svg = s("svg", { class: "graph", tabindex: 0, "aria-label": "Lifecycle graph" });
        this.viewport = s("g");
        this.svg.appendChild(this.viewport);
        container.appendChild(this.svg);
        this.bindEvents();
    }

    /** Set the graph, the layout is only recomputed when the key changes */
    async setGraph(
        graph: Graph,
        key: string,
        overrides: Record<string, { x: number; y: number }>,
        stages: readonly { id: string; column?: number; row?: number }[] = [],
    ): Promise<void> {
        this.stageDefinitions = new Map(stages.map((s) => [s.id, s]));
        const relayout = key !== this.layoutKey || this.graph === null;
        this.graph = graph;
        if (relayout) {
            const version = ++this.layoutVersion;
            this.container.classList.add("busy");
            const { boxes, empty } = await this.layout(graph);
            if (version !== this.layoutVersion) {
                return;
            }
            this.container.classList.remove("busy");
            const previous = this.layoutKey;
            this.boxes = boxes;
            this.emptyStageBoxes = empty;
            this.layoutKey = key;
            this.applyOverrides(overrides);
            this.render();
            // Fit when the view changes, keep the viewport on edits
            if (previous.split("|")[0] !== key.split("|")[0]) {
                this.fit();
            }
            return;
        }
        this.applyOverrides(overrides);
        this.render();
    }

    private applyOverrides(overrides: Record<string, { x: number; y: number }>): void {
        for (const [id, p] of Object.entries(overrides)) {
            const box = this.boxes.get(id);
            if (box) {
                box.x = p.x - box.w / 2;
                box.y = p.y - box.h / 2;
            }
        }
        this.computeStageBoxes();
    }

    /**
     * Two passes: the states of each stage are layered top to bottom, then the stages are placed
     * left to right, on the grid of the stage definitions when every stage has a column.
     */
    private async layout(graph: Graph): Promise<{ boxes: Map<string, Box>; empty: Map<string, Box> }> {
        const stageOf = new Map(graph.nodes.map((n) => [n.id, n.stage]));
        const byId = new Map(graph.nodes.map((n) => [n.id, n]));
        // A state with its generated states is laid out as one block
        const rootOf = (id: string) => {
            const parent = byId.get(id)?.parent;
            return parent !== undefined && byId.has(parent) ? parent : id;
        };
        const children = new Map<string, GraphNode[]>();
        for (const node of graph.nodes.filter((n) => rootOf(n.id) !== n.id)) {
            children.set(rootOf(node.id), [...(children.get(rootOf(node.id)) ?? []), node]);
        }
        const blockSize = (node: GraphNode) => {
            const kids = children.get(node.id) ?? [];
            return { width: Math.max(nodeWidth(node), ...kids.map((k) => CHILD_INDENT + nodeWidth(k))), height: NODE_H + kids.length * (NODE_H + CHILD_GAP) };
        };
        const blockEdges = (keep: (id: string) => boolean, unit: (id: string) => string) => {
            const seen = new Set<string>();
            return graph.edges
                .filter((e) => keep(e.source) && keep(e.target))
                .map((e) => [unit(e.source), unit(e.target)])
                .filter(([a, b]) => a !== b && !seen.has(`${a}>${b}`) && seen.add(`${a}>${b}`));
        };
        const nodesByStage = new Map<string, GraphNode[]>();
        for (const node of graph.nodes.filter((n) => rootOf(n.id) === n.id)) {
            nodesByStage.set(node.stage, [...(nodesByStage.get(node.stage) ?? []), node]);
        }

        // Pass 1: inside each stage
        const inner = new Map<string, { boxes: Map<string, Box>; w: number; h: number }>();
        for (const stage of graph.stages.filter((s) => !nodesByStage.has(s.id))) {
            inner.set(stage.id, { boxes: new Map(), ...EMPTY_STAGE });
        }
        for (const stage of graph.stages.filter((s) => nodesByStage.has(s.id))) {
            const members = nodesByStage.get(stage.id)!;
            const ids = new Set(members.map((n) => n.id));
            const result: ElkNode = await this.elk.layout({
                id: stage.id,
                layoutOptions: {
                    "elk.algorithm": "layered",
                    "elk.direction": "DOWN",
                    "elk.layered.spacing.nodeNodeBetweenLayers": "26",
                    "elk.spacing.nodeNode": "22",
                    "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
                    "elk.padding": "[top=36,left=14,bottom=14,right=14]",
                },
                children: members.map((n) => ({ id: n.id, ...blockSize(n) })),
                edges: blockEdges((id) => ids.has(rootOf(id)), rootOf).map(([a, b], i) => ({ id: `e${i}`, sources: [a], targets: [b] })),
            });
            const boxes = new Map<string, Box>();
            for (const c of result.children ?? []) {
                boxes.set(c.id, { x: c.x ?? 0, y: c.y ?? 0, w: c.width ?? 140, h: c.height ?? NODE_H });
            }
            inner.set(stage.id, { boxes, w: result.width ?? 200, h: result.height ?? 80 });
        }

        // Pass 2: the stages and the states outside of any stage
        const unit = (id: string) => (stageOf.get(rootOf(id)) ? `stage:${stageOf.get(rootOf(id))}` : rootOf(id));
        const placed = new Map<string, { x: number; y: number }>();
        const definitions = this.stageDefinitions;
        // Declared stages go left to right in their order, or on the cell of their column and row
        const grid = graph.stages.length > 0 && graph.stages.every((s) => definitions.has(s.id));
        if (grid) {
            const cell = new Map(graph.stages.map((s, i) => [s.id, { column: definitions.get(s.id)!.column ?? i, row: definitions.get(s.id)!.row ?? 0 }]));
            const columns = new Map<number, number>();
            const rows = new Map<number, number>();
            for (const [id, size] of inner) {
                const c = cell.get(id)!;
                columns.set(c.column, Math.max(columns.get(c.column) ?? 0, size.w));
                rows.set(c.row, Math.max(rows.get(c.row) ?? 0, size.h));
            }
            const offset = (sizes: Map<number, number>, index: number, gap: number) =>
                [...sizes.keys()].filter((k) => k < index).reduce((sum, k) => sum + sizes.get(k)! + gap, 0);
            for (const id of inner.keys()) {
                const c = cell.get(id)!;
                placed.set(`stage:${id}`, { x: 200 + offset(columns, c.column, 110), y: offset(rows, c.row, 70) });
            }
            // States outside of the stages: the entry ones left of the grid, the others right of it
            const staged = new Set(graph.nodes.filter((n) => n.stage !== "").map((n) => n.id));
            const right = 200 + offset(columns, Math.max(...columns.keys()) + 1, 110);
            const y = { left: 0, right: 0 };
            for (const node of nodesByStage.get("") ?? []) {
                const side = node.initial || !graph.edges.some((e) => e.target === node.id && staged.has(e.source)) ? "left" : "right";
                placed.set(node.id, { x: side === "left" ? 0 : right, y: y[side] });
                y[side] += blockSize(node).height + 20;
            }
        } else {
            const edges = blockEdges(() => true, unit);
            const result = await this.elk.layout({
                id: "root",
                layoutOptions: {
                    "elk.algorithm": "layered",
                    "elk.direction": "RIGHT",
                    "elk.layered.spacing.nodeNodeBetweenLayers": "90",
                    "elk.spacing.nodeNode": "40",
                    "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
                    "elk.layered.cycleBreaking.strategy": "MODEL_ORDER",
                },
                children: [
                    ...[...inner].map(([id, size]) => ({ id: `stage:${id}`, width: size.w, height: size.h })),
                    ...(nodesByStage.get("") ?? []).map((n) => ({ id: n.id, ...blockSize(n) })),
                ].sort((a, b) => this.modelOrder(graph, a.id) - this.modelOrder(graph, b.id)),
                edges: edges.map(([a, b], i) => ({ id: `e${i}`, sources: [a], targets: [b] })),
            });
            for (const c of result.children ?? []) {
                placed.set(c.id, { x: c.x ?? 0, y: c.y ?? 0 });
            }
        }

        const boxes = new Map<string, Box>();
        const empty = new Map<string, Box>();
        for (const stage of graph.stages.filter((s) => !nodesByStage.has(s.id))) {
            const p = placed.get(`stage:${stage.id}`) ?? { x: 0, y: 0 };
            empty.set(stage.id, { x: p.x, y: p.y, w: EMPTY_STAGE.w, h: EMPTY_STAGE.h });
        }
        for (const node of graph.nodes.filter((n) => rootOf(n.id) === n.id)) {
            let p: { x: number; y: number };
            if (node.stage === "") {
                p = placed.get(node.id) ?? { x: 0, y: 0 };
            } else {
                const origin = placed.get(`stage:${node.stage}`) ?? { x: 0, y: 0 };
                const b = inner.get(node.stage)!.boxes.get(node.id)!;
                p = { x: b.x + origin.x, y: b.y + origin.y };
            }
            boxes.set(node.id, { x: p.x, y: p.y, w: nodeWidth(node), h: NODE_H });
            (children.get(node.id) ?? []).forEach((child, i) => {
                boxes.set(child.id, { x: p.x + CHILD_INDENT, y: p.y + (i + 1) * (NODE_H + CHILD_GAP), w: nodeWidth(child), h: NODE_H });
            });
        }
        return { boxes, empty };
    }

    /** Position of the first state of a layout unit in the csv, to keep the csv order, empty stages go last */
    private modelOrder(graph: Graph, unit: string): number {
        const stage = unit.startsWith("stage:") ? unit.slice(6) : null;
        const index = graph.nodes.findIndex((n) => (stage === null ? n.id === unit : n.stage === stage));
        return index >= 0 ? index : graph.nodes.length + graph.stages.findIndex((s) => s.id === stage);
    }

    /** The boxes around the states of each stage, leaving out the state being dragged */
    private computeStageBoxes(dragged?: string): void {
        this.stageBoxes.clear();
        for (const node of this.graph?.nodes ?? []) {
            const b = this.boxes.get(node.id);
            if (!b || node.stage === "" || node.id === dragged) {
                continue;
            }
            const current = this.stageBoxes.get(node.stage);
            const x0 = Math.min(current?.x ?? Infinity, b.x - 14);
            const y0 = Math.min(current?.y ?? Infinity, b.y - 36);
            const x1 = Math.max(current ? current.x + current.w : -Infinity, b.x + b.w + 14);
            const y1 = Math.max(current ? current.y + current.h : -Infinity, b.y + b.h + 14);
            this.stageBoxes.set(node.stage, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
        }
        for (const stage of this.graph?.stages ?? []) {
            const b = this.emptyStageBoxes.get(stage.id);
            if (b && !this.stageBoxes.has(stage.id)) {
                this.stageBoxes.set(stage.id, b);
            }
        }
    }

    /** The stage, other than its own, the center of the dragged state is in */
    private stageUnder(id: string): string | null {
        const b = this.boxes.get(id);
        const own = this.graph?.nodes.find((n) => n.id === id)?.stage;
        if (!b) {
            return null;
        }
        const cx = b.x + b.w / 2;
        const cy = b.y + b.h / 2;
        const ownBox = own ? this.stageBoxes.get(own) : undefined;
        if (ownBox && cx >= ownBox.x && cx <= ownBox.x + ownBox.w && cy >= ownBox.y && cy <= ownBox.y + ownBox.h) {
            return null;
        }
        for (const [stage, box] of this.stageBoxes) {
            if (stage !== own && cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h) {
                return stage;
            }
        }
        return null;
    }

    /** The current center positions of all nodes */
    positions(): Record<string, { x: number; y: number }> {
        const result: Record<string, { x: number; y: number }> = {};
        for (const [id, b] of this.boxes) {
            result[id] = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
        }
        return result;
    }

    setStyle(style: GraphStyle): void {
        this.style = style;
        this.render();
    }

    private applyTransform(): void {
        const { k, x, y } = this.transform;
        this.viewport.setAttribute("transform", `translate(${x},${y}) scale(${k})`);
    }

    fit(ids?: string[]): void {
        const boxes = [...this.boxes.entries()].filter(([id]) => !ids || ids.includes(id)).map(([, b]) => b);
        if (boxes.length === 0) {
            return;
        }
        const x0 = Math.min(...boxes.map((b) => b.x)) - 40;
        const y0 = Math.min(...boxes.map((b) => b.y)) - 50;
        const x1 = Math.max(...boxes.map((b) => b.x + b.w)) + 40;
        const y1 = Math.max(...boxes.map((b) => b.y + b.h)) + 60;
        const rect = this.svg.getBoundingClientRect();
        const k = Math.min(1.4, Math.min(rect.width / (x1 - x0), rect.height / (y1 - y0)));
        this.transform = { k, x: (rect.width - (x1 - x0) * k) / 2 - x0 * k, y: (rect.height - (y1 - y0) * k) / 2 - y0 * k };
        this.applyTransform();
    }

    zoom(factor: number, cx?: number, cy?: number): void {
        const rect = this.svg.getBoundingClientRect();
        const px = cx ?? rect.width / 2;
        const py = cy ?? rect.height / 2;
        const k = Math.min(4, Math.max(0.08, this.transform.k * factor));
        this.transform = { k, x: px - ((px - this.transform.x) * k) / this.transform.k, y: py - ((py - this.transform.y) * k) / this.transform.k };
        this.applyTransform();
    }

    /** Pan so the node is in view */
    reveal(id: string): void {
        const b = this.boxes.get(id);
        if (!b) {
            return;
        }
        const rect = this.svg.getBoundingClientRect();
        const { k } = this.transform;
        const sx = (b.x + b.w / 2) * k + this.transform.x;
        const sy = (b.y + b.h / 2) * k + this.transform.y;
        if (sx < 40 || sy < 40 || sx > rect.width - 40 || sy > rect.height - 40) {
            this.transform = { k, x: rect.width / 2 - (b.x + b.w / 2) * k, y: rect.height / 2 - (b.y + b.h / 2) * k };
            this.applyTransform();
        }
    }

    private render(): void {
        const graph = this.graph;
        const style = this.style;
        if (!graph || !style) {
            return;
        }
        clear(this.viewport);
        this.applyTransform();

        const selected = style.selection;
        const neighbours = new Set<string>();
        if (selected?.type === "node") {
            neighbours.add(selected.id);
            for (const e of graph.edges) {
                if (primaryKind(e, style.hidden) === null) {
                    continue;
                }
                if (e.source === selected.id) {
                    neighbours.add(e.target);
                }
                if (e.target === selected.id) {
                    neighbours.add(e.source);
                }
            }
        } else if (selected?.type === "edge") {
            const e = graph.edges.find((x) => x.id === selected.id);
            if (e) {
                neighbours.add(e.source).add(e.target);
            }
        } else if (selected?.type === "stage") {
            graph.nodes.filter((n) => n.stage === selected.id).forEach((n) => neighbours.add(n.id));
        } else if (selected?.type === "desired") {
            graph.nodes.filter((n) => n.desiredState === selected.id).forEach((n) => neighbours.add(n.id));
        }
        const simulating = style.current !== null;
        const routePairs = new Set<string>();
        style.trail.forEach((id, i) => {
            if (i > 0 && style.trail[i - 1] !== id) {
                routePairs.add(`${style.trail[i - 1]}>${id}`);
            }
        });
        const query = style.search.trim().toLowerCase();

        // Stages
        const stagesLayer = s("g", { class: "stages" });
        const editableStages = style.editable && graph.view === "csv";
        for (const stage of graph.stages) {
            const b = this.stageBoxes.get(stage.id);
            if (!b) {
                continue;
            }
            let cls = "stage";
            if (this.dropStage === stage.id) {
                cls += " drop-target";
            }
            if (selected?.type === "stage" && selected.id === stage.id) {
                cls += " selected";
            }
            const empty = !graph.nodes.some((n) => n.stage === stage.id);
            stagesLayer.appendChild(
                s("g", { class: cls },
                    s("rect", { x: b.x, y: b.y, width: b.w, height: b.h, rx: 8 }),
                    s("text", { x: b.x + 12, y: b.y + 21, class: `stage-title${editableStages ? " grip" : ""}`, "data-stage": stage.id }, stage.name.toUpperCase(),
                        s("title", {}, `${stage.description ? `${stage.description}\n` : ""}stage ${stage.id}${editableStages ? "\nDrag to move the stage, click to edit it" : ""}`)),
                    empty ? s("text", { x: b.x + 12, y: b.y + 52, class: "stage-empty" }, editableStages ? "Drop states here" : "No states") : null),
            );
        }
        this.viewport.appendChild(stagesLayer);

        // Edges
        const edgesLayer = s("g", { class: "edges" });
        const routeLayer = s("g", { class: "route" });
        const pairs = new Set(graph.edges.map((e) => `${e.source}>${e.target}`));
        for (const edge of graph.edges) {
            const kind = primaryKind(edge, style.hidden);
            const a = this.boxes.get(edge.source);
            const b = this.boxes.get(edge.target);
            if (kind === null || !a || !b) {
                continue;
            }
            const offset = pairs.has(`${edge.target}>${edge.source}`) ? 5 : 0;
            const p = edgeCurve(a, b, offset);
            const d = curvePath(p);
            const paths = arrow(p, 9);
            const isSelected = selected?.type === "edge" && selected.id === edge.id;
            const touches = selected?.type === "node" && (edge.source === selected.id || edge.target === selected.id);
            let cls = `edge k-${kind}`;
            if (DASHED.has(kind)) {
                cls += " dashed";
            }
            if (isSelected || touches) {
                cls += " strong";
            } else if (selected && !(selected.type === "stage" && neighbours.has(edge.source) && neighbours.has(edge.target))) {
                cls += " faded";
            }
            if (simulating) {
                cls += edge.source === style.current && style.next.has(edge.target) ? " strong" : " faded";
            }
            const title = edge.details.map((x) => `${x.state}.${x.trigger} = ${x.raw}${x.operation ? ` (${x.operation})` : ""}`).join("\n");
            const group = s("g", { class: cls, "data-edge": edge.id },
                s("path", { d: paths.line, class: "line" }),
                s("path", { d: paths.head, class: `mk k-${kind}` }),
                s("path", { d, class: "hit" }),
                s("title", {}, title));
            if (edge.details.some((x) => x.validate) && !simulating) {
                const m = cubicPoint(p, 0.5);
                group.appendChild(s("g", { class: "vmark", transform: `translate(${m.x},${m.y})` }, s("circle", { r: 6.5 }), s("path", { d: "M-3,0 L-1,2.5 L3.2,-2.5" })));
            }
            edgesLayer.appendChild(group);
        }
        // Simulation trail
        let step = 0;
        style.trail.forEach((id, i) => {
            const prev = style.trail[i - 1];
            if (i === 0 || prev === id) {
                return;
            }
            const a = this.boxes.get(prev);
            const b = this.boxes.get(id);
            step++;
            if (!a || !b) {
                return;
            }
            const p = edgeCurve(a, b, 0);
            const m = cubicPoint(p, 0.5);
            const route = arrow(p, 13);
            routeLayer.appendChild(s("path", { d: route.line, class: "route-line" }));
            routeLayer.appendChild(s("path", { d: route.head, class: "mk route" }));
            routeLayer.appendChild(s("g", { transform: `translate(${m.x},${m.y})`, class: "route-step" }, s("circle", { r: 8 }), s("text", { y: 3.5 }, String(step))));
        });
        this.viewport.appendChild(edgesLayer);
        this.viewport.appendChild(routeLayer);

        // Nodes
        const nodesLayer = s("g", { class: "nodes" });
        for (const node of graph.nodes) {
            const b = this.boxes.get(node.id);
            if (!b) {
                continue;
            }
            let cls = `node l-${node.label ?? "none"}`;
            if (node.generated) {
                cls += " generated";
            }
            if (node.deleted) {
                cls += " deleted";
            }
            if (selected && !neighbours.has(node.id)) {
                cls += " faded";
            }
            if (simulating && node.id !== style.current && !style.next.has(node.id) && !style.trail.includes(node.id)) {
                cls += " faded";
            }
            if (selected?.type === "node" && selected.id === node.id) {
                cls += " selected";
            }
            if (query && (node.id.includes(query) || node.title.toLowerCase().includes(query))) {
                cls += " match";
            }
            const g = s("g", { class: cls, "data-node": node.id, transform: `translate(${b.x},${b.y})` },
                s("rect", { class: "body", width: b.w, height: b.h, rx: 5 }),
                s("path", { class: "strip", d: `M6,0 V${b.h} H5 A5,5 0 0 1 0,${b.h - 5} V5 A5,5 0 0 1 5,0 Z` }),
                s("text", { x: node.initial ? 24 : 14, y: b.h / 2 + 4.5, class: "name" }, node.id),
                s("title", {}, `${node.title}\ndesired state: ${node.desiredState ?? "-"}${node.protected ? "\nprotected: no on_delete" : ""}${node.selfLoops.length ? `\nloops: ${node.selfLoops.join(", ")}` : ""}`));
            if (node.initial) {
                g.appendChild(s("path", { class: "initial", d: `M11,${b.h / 2 - 5} L18,${b.h / 2} L11,${b.h / 2 + 5} z` }));
            }
            const badges: string[] = [];
            if (node.selfLoops.length) {
                badges.push("↻");
            }
            if (node.protected && !node.generated) {
                badges.push("⛨");
            }
            if (badges.length) {
                g.appendChild(s("text", { x: b.w - 8, y: b.h / 2 + 4.5, class: "badges", "text-anchor": "end" }, badges.join(" ")));
            }
            const problem = style.problems.get(node.id);
            if (problem) {
                g.appendChild(s("circle", { class: `problem p-${problem}`, cx: b.w - 2, cy: 2, r: 4.5 }));
            }
            if (style.editable && selected?.type === "node" && selected.id === node.id && !node.generated) {
                g.appendChild(s("circle", { class: "handle", cx: b.w, cy: b.h / 2, r: 7, "data-handle": node.id }, s("title", {}, "Drag to another state to add a transfer")));
            }
            nodesLayer.appendChild(g);
        }
        if (simulating && style.current) {
            const b = this.boxes.get(style.current);
            if (b) {
                nodesLayer.appendChild(s("rect", { class: "current-ring", x: b.x - 5, y: b.y - 5, width: b.w + 10, height: b.h + 10, rx: 8 }));
            }
        }
        this.viewport.appendChild(nodesLayer);
    }

    private toGraph(clientX: number, clientY: number): { x: number; y: number } {
        const rect = this.svg.getBoundingClientRect();
        return { x: (clientX - rect.left - this.transform.x) / this.transform.k, y: (clientY - rect.top - this.transform.y) / this.transform.k };
    }

    private bindEvents(): void {
        this.svg.addEventListener("wheel", (e) => {
            e.preventDefault();
            const rect = this.svg.getBoundingClientRect();
            this.zoom(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - rect.left, e.clientY - rect.top);
        }, { passive: false });

        this.svg.addEventListener("pointerdown", (e) => {
            const target = e.target as Element;
            const handle = target.closest("[data-handle]")?.getAttribute("data-handle");
            const node = target.closest("[data-node]")?.getAttribute("data-node");
            const edge = target.closest("[data-edge]")?.getAttribute("data-edge");
            const stage = target.closest("[data-stage]")?.getAttribute("data-stage");
            const hit: GraphSelection = node ? { type: "node", id: node } : edge ? { type: "edge", id: edge } : stage ? { type: "stage", id: stage } : null;
            const start = { startX: e.clientX, startY: e.clientY, moved: false, hit };
            const editable = this.style?.editable && this.graph?.view === "csv";
            if (handle) {
                this.drag = { kind: "connect", id: handle, ox: 0, oy: 0, ...start };
            } else if (node && editable) {
                const b = this.boxes.get(node)!;
                const p = this.toGraph(e.clientX, e.clientY);
                const own = this.graph?.nodes.find((n) => n.id === node)?.stage;
                const stageBox = own ? this.stageBoxes.get(own) : undefined;
                this.drag = { kind: "node", id: node, ox: p.x - b.x, oy: p.y - b.y, ...start, stageBox: stageBox && { ...stageBox } };
            } else if (stage && editable) {
                const p = this.toGraph(e.clientX, e.clientY);
                this.drag = { kind: "stage", id: stage, ox: p.x, oy: p.y, ...start };
            } else {
                this.drag = { kind: "pan", ox: this.transform.x, oy: this.transform.y, ...start };
            }
            this.svg.setPointerCapture(e.pointerId);
        });

        this.svg.addEventListener("pointermove", (e) => {
            const drag = this.drag;
            if (!drag) {
                return;
            }
            if (Math.abs(e.clientX - drag.startX) + Math.abs(e.clientY - drag.startY) > 3) {
                drag.moved = true;
            }
            if (!drag.moved) {
                return;
            }
            if (drag.kind === "pan") {
                this.transform.x = drag.ox + e.clientX - drag.startX;
                this.transform.y = drag.oy + e.clientY - drag.startY;
                this.applyTransform();
            } else if (drag.kind === "node" && drag.id) {
                const b = this.boxes.get(drag.id)!;
                const p = this.toGraph(e.clientX, e.clientY);
                b.x = Math.round((p.x - drag.ox) / 4) * 4;
                b.y = Math.round((p.y - drag.oy) / 4) * 4;
                this.computeStageBoxes(drag.id);
                const own = this.graph?.nodes.find((n) => n.id === drag.id)?.stage;
                const current = own ? this.stageBoxes.get(own) : undefined;
                if (own && drag.stageBox) {
                    this.stageBoxes.set(own, current ? union(current, drag.stageBox) : drag.stageBox);
                }
                this.dropStage = this.stageUnder(drag.id);
                this.render();
            } else if (drag.kind === "stage" && drag.id) {
                const p = this.toGraph(e.clientX, e.clientY);
                const dx = Math.round((p.x - drag.ox) / 4) * 4;
                const dy = Math.round((p.y - drag.oy) / 4) * 4;
                if (dx === 0 && dy === 0) {
                    return;
                }
                drag.ox += dx;
                drag.oy += dy;
                for (const node of this.graph?.nodes.filter((n) => n.stage === drag.id) ?? []) {
                    const b = this.boxes.get(node.id)!;
                    b.x += dx;
                    b.y += dy;
                }
                const empty = this.emptyStageBoxes.get(drag.id);
                if (empty) {
                    empty.x += dx;
                    empty.y += dy;
                }
                this.computeStageBoxes();
                this.render();
            } else if (drag.kind === "connect" && drag.id) {
                const b = this.boxes.get(drag.id)!;
                const p = this.toGraph(e.clientX, e.clientY);
                if (!this.tempLine) {
                    this.tempLine = s("path", { class: "temp-line" });
                }
                this.tempLine.setAttribute("d", `M${b.x + b.w},${b.y + b.h / 2} L${p.x},${p.y}`);
                this.viewport.appendChild(this.tempLine);
            }
        });

        this.svg.addEventListener("pointerup", (e) => {
            const drag = this.drag;
            this.drag = null;
            this.tempLine?.remove();
            this.tempLine = null;
            if (!drag) {
                return;
            }
            if (drag.kind === "connect" && drag.id) {
                const under = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-node]")?.getAttribute("data-node");
                if (under && drag.moved) {
                    this.callbacks.connect(drag.id, under, e.clientX, e.clientY);
                }
                return;
            }
            if (drag.kind === "node" && drag.moved && drag.id) {
                const stage = this.dropStage;
                this.dropStage = null;
                this.computeStageBoxes();
                if (stage !== null) {
                    this.render();
                    this.callbacks.restage(drag.id, stage);
                    return;
                }
                const b = this.boxes.get(drag.id)!;
                this.callbacks.move({ [drag.id]: { x: b.x + b.w / 2, y: b.y + b.h / 2 } });
                return;
            }
            if (drag.kind === "stage" && drag.moved && drag.id) {
                const positions: Record<string, { x: number; y: number }> = {};
                for (const node of this.graph?.nodes.filter((n) => n.stage === drag.id) ?? []) {
                    const b = this.boxes.get(node.id)!;
                    positions[node.id] = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
                }
                if (Object.keys(positions).length) {
                    this.callbacks.move(positions);
                }
                return;
            }
            if (!drag.moved) {
                this.callbacks.select(drag.hit);
            }
        });

        this.svg.addEventListener("dblclick", (e) => {
            const node = (e.target as Element).closest("[data-node]")?.getAttribute("data-node");
            if (node) {
                this.callbacks.activate(node);
            }
        });
    }

    dispose(): void {
        clear(this.container);
    }
}
