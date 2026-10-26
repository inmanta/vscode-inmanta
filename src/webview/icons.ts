/**
 * Font Awesome icons by their react-icons name (FaCheck, FaRegCircle, ...), the way the web
 * console renders the web_icon annotations, with FaQuestionCircle for an unknown name.
 */
import * as fa from "fa-icon-trees";
import { h } from "./dom";

interface IconTree {
    tag: string;
    attr: Record<string, string>;
    child: IconTree[];
}

const SVG_NS = "http://www.w3.org/2000/svg";

function build(node: IconTree): SVGElement {
    const el = document.createElementNS(SVG_NS, node.tag);
    for (const [key, value] of Object.entries(node.attr)) {
        el.setAttribute(key === "viewBox" ? key : key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), value);
    }
    for (const child of node.child ?? []) {
        el.appendChild(build(child));
    }
    return el;
}

/** The names of all the icons, in alphabetical order */
export const ICON_NAMES: readonly string[] = Object.keys(fa).filter((name) => /^Fa[A-Z]/.test(name)).sort();

export function faIcon(name: string | null): HTMLElement | null {
    if (!name) {
        return null;
    }
    const svg = build((fa[name] ?? fa.FaQuestionCircle!)());
    svg.setAttribute("fill", "currentColor");
    svg.setAttribute("width", "1em");
    svg.setAttribute("height", "1em");
    svg.setAttribute("aria-hidden", "true");
    return h("span", { class: "pf-icon", title: name in fa ? name : `${name} is not a Font Awesome icon of react-icons` }, svg);
}
