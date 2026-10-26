/**
 * The web_* annotations of the states and transfers of a lifecycle: what reads them and what they do.
 */

export type AnnotationTarget = "state" | "transfer";

export interface AnnotationKey {
    key: string;
    on: AnnotationTarget;
    /** "boolean" values are written as true or false, "choice" values are one of `values` */
    type: "text" | "icon" | "stage" | "boolean" | "choice";
    values?: readonly string[];
    /** The web console reads it, the others come from the lifecycle visualization design */
    console: boolean;
    description: string;
}

export const ANNOTATION_KEYS: readonly AnnotationKey[] = [
    { key: "web_label", on: "state", type: "text", console: true, description: "Name of the state in the web console, also the button label of transfers to it" },
    { key: "web_icon", on: "state", type: "icon", console: true, description: "Font Awesome icon on the state badge" },
    { key: "web_stage", on: "state", type: "stage", console: false, description: "Id of the stage the state is grouped in, defaults to the desired state" },
    { key: "web_description", on: "state", type: "text", console: true, description: "Tooltip of the state badge" },
    { key: "web_kind", on: "state", type: "text", console: false, description: "Tag of the state, route planning avoids failed, rejected and non_compliant" },
    { key: "web_button_label", on: "transfer", type: "text", console: true, description: "Label of the Actions menu item, defaults to the web_label of the target" },
    { key: "web_icon", on: "transfer", type: "icon", console: true, description: "Font Awesome icon of the Actions menu item" },
    { key: "web_confirm", on: "transfer", type: "text", console: true, description: "Confirmation prompt before a set state or delete" },
    { key: "web_button_type", on: "transfer", type: "choice", values: ["primary", "secondary", "tertiary", "link"], console: true, description: "Emphasis of the Actions menu item" },
    { key: "web_button_variant", on: "transfer", type: "choice", values: ["danger", "warning"], console: true, description: "Status styling of the Actions menu item" },
    { key: "web_advanced_state", on: "transfer", type: "boolean", console: true, description: "Moves a set state item under Advanced in the Actions menu" },
    { key: "web_action", on: "transfer", type: "text", console: false, description: "Title of the step in a route" },
    { key: "web_flow", on: "transfer", type: "boolean", console: false, description: "Part of the intended flow, preferred by route planning" },
];

export function annotationKeys(on: AnnotationTarget): AnnotationKey[] {
    return ANNOTATION_KEYS.filter((a) => a.on === on);
}

export function annotationKey(key: string, on: AnnotationTarget): AnnotationKey | undefined {
    return ANNOTATION_KEYS.find((a) => a.key === key && a.on === on);
}

/** The description of a key, with the part that reads it */
export function annotationHint(a: AnnotationKey): string {
    return `${a.description}${a.console ? "" : " (the web console doesn't read it yet)"}`;
}
