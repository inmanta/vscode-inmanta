export type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, string | number | boolean | null | undefined | EventListener | Partial<CSSStyleDeclaration>>;

function append(parent: Node, child: Child): void {
    if (child === null || child === undefined || child === false) {
        return;
    }
    if (Array.isArray(child)) {
        child.forEach((c) => append(parent, c));
    } else if (child instanceof Node) {
        parent.appendChild(child);
    } else {
        parent.appendChild(document.createTextNode(String(child)));
    }
}

function applyAttrs(el: Element, attrs: Attrs | null): void {
    for (const [key, value] of Object.entries(attrs ?? {})) {
        if (value === null || value === undefined || value === false) {
            continue;
        }
        if (key.startsWith("on") && typeof value === "function") {
            el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
        } else if (key === "style" && typeof value === "object") {
            Object.assign((el as HTMLElement).style, value);
        } else if (key === "value" && "value" in el) {
            (el as HTMLInputElement).value = String(value);
        } else if (key === "checked" && "checked" in el) {
            (el as HTMLInputElement).checked = Boolean(value);
        } else {
            el.setAttribute(key, value === true ? "" : String(value));
        }
    }
}

/** Create an html element */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    applyAttrs(el, attrs ?? null);
    append(el, children);
    return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Create an svg element */
export function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): SVGElementTagNameMap[K] {
    const el = document.createElementNS(SVG_NS, tag);
    applyAttrs(el, attrs ?? null);
    append(el, children);
    return el;
}

export function clear(el: Element): void {
    while (el.firstChild) {
        el.removeChild(el.firstChild);
    }
}

/** Append children, skipping empty ones */
export function add(parent: Element, ...children: Child[]): void {
    append(parent, children);
}
