/**
 * What the web console shows for a service instance in a state: the state badge and the
 * Actions menu.  Mirrors InstanceStateLabel, getAvailableStateTargets and InstanceActions of
 * the web-console, with the transfer annotations taken from the transfers csv.
 */
import { LsmLifecycle, LsmTransfer } from "./expand";
import { Metadata } from "./metadata";
import { parseTransfer } from "./model";

export interface ConsoleBadge {
    text: string;
    /** Status color, null renders the name as plain text unless there are annotations */
    label: string | null;
    icon: string | null;
    description: string | null;
    /** No badge, just the name */
    plain: boolean;
}

export interface ConsoleAction {
    target: string;
    label: string;
    icon: string | null;
    variant: "danger" | "warning" | null;
    buttonType: string | null;
    advanced: boolean;
    /** Text of the confirmation dialog */
    confirm: string;
    transfer: LsmTransfer;
}

export interface ConsoleView {
    badge: ConsoleBadge;
    edit: { enabled: boolean; confirm: string | null };
    delete: { enabled: boolean; confirm: string };
    setState: ConsoleAction[];
    advanced: ConsoleAction[];
}

/** The annotations of an lsm transfer, from the metadata entry of the csv transfer it comes from */
export function transferAnnotations(transfer: LsmTransfer, metadata: Metadata): Record<string, string | boolean> {
    if (transfer.origin.role !== "direct" && transfer.origin.role !== "incoming") {
        // Generated retry, cancel and deploy transfers have no annotations
        return {};
    }
    const target = parseTransfer(transfer.origin.raw)?.target;
    const entry = metadata.transfers.find((t) => t.source === transfer.origin.state && t.trigger === transfer.origin.trigger && t.target === target);
    return entry?.annotations ?? {};
}

function text(value: string | boolean | undefined): string | null {
    return typeof value === "string" && value !== "" ? value : null;
}

export function badgeFor(lifecycle: LsmLifecycle, stateName: string): ConsoleBadge {
    const state = lifecycle.states.get(stateName);
    const annotations = state?.annotations ?? {};
    const hasAnnotations = Object.keys(annotations).length > 0;
    return {
        text: annotations.web_label || stateName,
        label: state?.label ?? null,
        icon: annotations.web_icon || null,
        description: annotations.web_description || null,
        plain: !state?.label && !hasAnnotations,
    };
}

export function consoleView(lifecycle: LsmLifecycle, metadata: Metadata, stateName: string, identity = "my-instance", service = "service"): ConsoleView {
    const outgoing = lifecycle.transfers.filter((t) => t.source === stateName);
    const update = outgoing.find((t) => t.onUpdate);
    const remove = outgoing.find((t) => t.onDelete);
    const deleted = lifecycle.states.get(stateName)?.deleted ?? false;

    const actions = outgoing
        .filter((t) => t.apiSetState)
        .map((t): ConsoleAction => {
            const annotations = transferAnnotations(t, metadata);
            const variant = text(annotations.web_button_variant);
            return {
                target: t.target,
                label: text(annotations.web_button_label) ?? lifecycle.states.get(t.target)?.annotations.web_label ?? t.target,
                icon: text(annotations.web_icon),
                variant: variant === "danger" || variant === "warning" ? variant : null,
                buttonType: text(annotations.web_button_type),
                advanced: annotations.web_advanced_state === true,
                confirm: text(annotations.web_confirm) ?? `Are you sure you want to set state of instance ${identity} to ${t.target}?`,
                transfer: t,
            };
        })
        .sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));

    return {
        badge: badgeFor(lifecycle, stateName),
        edit: { enabled: !deleted && update !== undefined, confirm: update ? text(transferAnnotations(update, metadata).web_confirm) : null },
        delete: {
            enabled: !deleted && remove !== undefined,
            confirm: (remove && text(transferAnnotations(remove, metadata).web_confirm)) ?? `Are you sure you want to delete instance ${identity} of service entity ${service}?`,
        },
        setState: actions.filter((a) => !a.advanced),
        advanced: actions.filter((a) => a.advanced),
    };
}
