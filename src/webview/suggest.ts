/**
 * A suggestion list under a text input: typing filters it, arrows move, Enter or a click picks.
 */
import { rank, Suggestion } from "../lifecycle/table";
import { add, clear, h } from "./dom";
import { faIcon } from "./icons";

const LIMIT = 40;

let floating: HTMLElement | null = null;

function list(): HTMLElement {
    if (floating === null) {
        floating = h("div", { class: "grid-float", hidden: true });
        document.body.appendChild(floating);
    }
    return floating;
}

/**
 * Show the suggestions of `candidates` while the input has focus, `pick` gets the chosen value.
 * With `icons` each suggestion shows the Font Awesome icon of its value.
 */
export function attachSuggestions(input: HTMLInputElement, candidates: () => readonly Suggestion[], pick: (value: string) => void, icons = false): void {
    let shown: Suggestion[] = [];
    let active = -1;
    const hide = () => {
        list().hidden = true;
        shown = [];
    };
    const choose = (value: string) => {
        hide();
        input.value = value;
        pick(value);
    };
    const render = () => {
        const float = list();
        shown = rank(candidates(), input.value.trim(), LIMIT).filter((s) => s.value !== input.value);
        clear(float);
        if (shown.length === 0) {
            float.hidden = true;
            return;
        }
        add(float, h("ul", { class: "grid-suggestions" }, shown.map((s, i) => h("li", {
            class: i === active ? "active" : "",
            title: s.detail,
            onmousedown: (e: Event) => {
                e.preventDefault();
                choose(s.value);
            },
        }, icons ? faIcon(s.value) : null, h("span", null, s.value), s.detail ? h("small", null, s.detail) : null))));
        const rect = input.getBoundingClientRect();
        float.style.left = `${rect.left}px`;
        float.style.top = `${rect.bottom + 2}px`;
        float.style.minWidth = `${Math.max(rect.width, 220)}px`;
        float.hidden = false;
        float.querySelector("li.active")?.scrollIntoView({ block: "nearest" });
    };
    input.setAttribute("autocomplete", "off");
    input.addEventListener("focus", () => {
        active = -1;
        render();
    });
    input.addEventListener("input", () => {
        active = -1;
        render();
    });
    input.addEventListener("blur", hide);
    input.addEventListener("keydown", (e) => {
        if (shown.length === 0) {
            return;
        }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            active = (active + (e.key === "ArrowDown" ? 1 : shown.length - 1 + (active < 0 ? 1 : 0))) % shown.length;
            render();
        } else if (e.key === "Enter" && active >= 0) {
            e.preventDefault();
            e.stopImmediatePropagation();
            choose(shown[active].value);
        } else if (e.key === "Escape") {
            hide();
        }
    });
}
