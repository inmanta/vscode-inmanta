/**
 * The Lifecycle Studio: a custom editor for csv lifecycles, and the diagnostics of the
 * lifecycle checks on any lifecycle csv that is open.
 */
import * as path from "path";
import {
    commands,
    CustomTextEditorProvider,
    Diagnostic,
    Disposable,
    DiagnosticSeverity,
    ExtensionContext,
    languages,
    Position,
    Range,
    RelativePattern,
    Selection,
    TextDocument,
    TextEditorRevealType,
    Uri,
    ViewColumn,
    WebviewPanel,
    window,
    workspace,
    WorkspaceEdit,
} from "vscode";
import { parseCsv } from "./csv";
import { applyEdit, EditError, EditOp } from "./edit";
import { lint } from "./lint";
import {
    clearLayout,
    deleteScenario,
    deleteStateInMetadata,
    metadataPathFor,
    parseMetadata,
    renameStateInMetadata,
    Scenario,
    setLayout,
    setTransferAnnotations,
    TransferAnnotations,
    upsertScenario,
} from "./metadata";
import { isLifecycleHeader, parseLifecycleCsv, parseStatesCsv } from "./model";

export const VIEW_TYPE = "inmanta.lifecycleStudio";

export type MetadataOp =
    | { kind: "setLayout"; positions: Record<string, { x: number; y: number }> }
    | { kind: "clearLayout" }
    | { kind: "upsertScenario"; scenario: Scenario }
    | { kind: "deleteScenario"; name: string }
    | { kind: "setTransferAnnotations"; entry: TransferAnnotations };

/** Messages sent by the webview */
export type WebviewMessage =
    | { type: "ready" }
    | { type: "edit"; op: EditOp }
    | { type: "metadata"; op: MetadataOp }
    | { type: "open"; file: "csv" | "states" | "metadata"; line?: number };

/** Message sent to the webview */
export interface LoadMessage {
    type: "load";
    csv: string;
    states: string | null;
    metadata: string | null;
    files: { csv: string; states: string | null; metadata: string };
}

async function readText(uri: Uri): Promise<string | null> {
    const open = workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open) {
        return open.getText();
    }
    try {
        return Buffer.from(await workspace.fs.readFile(uri)).toString("utf8");
    } catch (_e) {
        return null;
    }
}

/** The metadata file and states csv belonging to a lifecycle csv */
async function relatedFiles(csv: Uri): Promise<{ metadata: Uri; states: Uri | null }> {
    const metadata = csv.with({ path: metadataPathFor(csv.path) });
    const metadataText = await readText(metadata);
    const dir = path.posix.dirname(csv.path);
    const configured = metadataText ? parseMetadata(metadataText).metadata.statesCsv : undefined;
    if (configured) {
        return { metadata, states: csv.with({ path: path.posix.resolve(dir, configured) }) };
    }
    const sibling = csv.with({ path: path.posix.join(dir, "states.csv") });
    if (sibling.toString() !== csv.toString() && (await readText(sibling)) !== null) {
        return { metadata, states: sibling };
    }
    return { metadata, states: null };
}

function isLifecycleDocument(document: TextDocument): boolean {
    if (!document.uri.path.toLowerCase().endsWith(".csv")) {
        return false;
    }
    const firstLine = document.lineAt(0).text;
    return isLifecycleHeader(parseCsv(firstLine).header.values);
}

async function writeText(uri: Uri, text: string): Promise<void> {
    const open = workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open) {
        const edit = new WorkspaceEdit();
        edit.replace(uri, new Range(new Position(0, 0), open.lineAt(open.lineCount - 1).range.end), text);
        await workspace.applyEdit(edit);
        await open.save();
        return;
    }
    await workspace.fs.writeFile(uri, Buffer.from(text, "utf8"));
}

function applyMetadataOp(text: string, op: MetadataOp): string {
    switch (op.kind) {
        case "setLayout":
            return setLayout(text, op.positions);
        case "clearLayout":
            return clearLayout(text);
        case "upsertScenario":
            return upsertScenario(text, op.scenario);
        case "deleteScenario":
            return deleteScenario(text, op.name);
        case "setTransferAnnotations":
            return setTransferAnnotations(text, op.entry);
    }
}

function debounce(f: () => void, ms: number): () => void {
    let timer: NodeJS.Timeout | undefined;
    return () => {
        clearTimeout(timer);
        timer = setTimeout(f, ms);
    };
}

/** Watch the given files, wherever they are */
function watchFiles(uris: Uri[], onChange: () => void): Disposable[] {
    return uris.flatMap((uri) => {
        const watcher = workspace.createFileSystemWatcher(new RelativePattern(Uri.joinPath(uri, ".."), path.posix.basename(uri.path)));
        return [watcher, watcher.onDidChange(onChange), watcher.onDidCreate(onChange), watcher.onDidDelete(onChange)];
    });
}

class LifecycleStudioProvider implements CustomTextEditorProvider {
    constructor(private readonly context: ExtensionContext) {}

    async resolveCustomTextEditor(document: TextDocument, panel: WebviewPanel): Promise<void> {
        const webview = panel.webview;
        const outDir = Uri.joinPath(this.context.extensionUri, "out");
        webview.options = { enableScripts: true, localResourceRoots: [outDir] };
        webview.html = this.html(webview.asWebviewUri(Uri.joinPath(outDir, "webview.js")).toString(), webview.cspSource);

        let related = await relatedFiles(document.uri);
        let watchers: Disposable[] = [];
        let watched = "";

        const send = async () => {
            related = await relatedFiles(document.uri);
            const files = [related.metadata, related.states].filter((u): u is Uri => u !== null);
            if (files.map((u) => u.toString()).join() !== watched) {
                watchers.forEach((w) => w.dispose());
                watchers = watchFiles(files, scheduleSend);
                watched = files.map((u) => u.toString()).join();
            }
            const message: LoadMessage = {
                type: "load",
                csv: document.getText(),
                states: related.states ? await readText(related.states) : null,
                metadata: await readText(related.metadata),
                files: {
                    csv: path.posix.basename(document.uri.path),
                    states: related.states ? path.posix.basename(related.states.path) : null,
                    metadata: path.posix.basename(related.metadata.path),
                },
            };
            await webview.postMessage(message);
        };
        // A single change can be reported by both the document and the file watcher
        const scheduleSend = debounce(() => void send(), 50);

        // Handle the messages one at a time, each edit is computed on the text left by the previous one
        let queue = Promise.resolve();
        const subscriptions = [
            workspace.onDidChangeTextDocument((e) => {
                const changed = e.document.uri.toString();
                if (changed === document.uri.toString() || changed === related.metadata.toString() || changed === related.states?.toString()) {
                    scheduleSend();
                }
            }),
            webview.onDidReceiveMessage((message: WebviewMessage) => {
                queue = queue.then(() => this.receive(document, message, related, send));
            }),
        ];
        panel.onDidDispose(() => [...subscriptions, ...watchers].forEach((s) => s.dispose()));
    }

    private async receive(
        document: TextDocument,
        message: WebviewMessage,
        related: { metadata: Uri; states: Uri | null },
        send: () => Promise<void>,
    ): Promise<void> {
        try {
            switch (message.type) {
                case "ready":
                    await send();
                    return;
                case "edit": {
                    const text = applyEdit(document.getText(), message.op);
                    const edit = new WorkspaceEdit();
                    edit.replace(document.uri, new Range(new Position(0, 0), document.lineAt(document.lineCount - 1).range.end), text);
                    await workspace.applyEdit(edit);
                    const op = message.op;
                    if (op.kind === "renameState" || op.kind === "deleteState") {
                        const metadata = await readText(related.metadata);
                        if (metadata) {
                            const updated = op.kind === "renameState" ? renameStateInMetadata(metadata, op.from, op.to) : deleteStateInMetadata(metadata, op.name);
                            await writeText(related.metadata, updated);
                        }
                    }
                    return;
                }
                case "metadata": {
                    const metadata = (await readText(related.metadata)) ?? "";
                    await writeText(related.metadata, applyMetadataOp(metadata, message.op));
                    return;
                }
                case "open": {
                    const uri = message.file === "csv" ? document.uri : message.file === "states" ? related.states : related.metadata;
                    if (uri === null) {
                        return;
                    }
                    if (message.file === "metadata" && (await readText(uri)) === null) {
                        await writeText(uri, applyMetadataOp("", { kind: "clearLayout" }));
                    }
                    const editor = await window.showTextDocument(uri, { viewColumn: ViewColumn.Beside, preview: false });
                    if (message.line !== undefined) {
                        const position = new Position(message.line, 0);
                        editor.selection = new Selection(position, position);
                        editor.revealRange(new Range(position, position), TextEditorRevealType.InCenter);
                    }
                    return;
                }
            }
        } catch (e) {
            if (e instanceof EditError) {
                void window.showWarningMessage(e.message);
            } else {
                void window.showErrorMessage(`Lifecycle Studio: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    }

    private html(script: string, cspSource: string): string {
        const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Lifecycle Studio</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
    }
}

/**
 * Report the lifecycle checks of the open lifecycle csv files as diagnostics.  Problems found
 * in a states csv are merged over all the open lifecycles using it.
 */
function registerDiagnostics(context: ExtensionContext): void {
    const collection = languages.createDiagnosticCollection("inmanta-lifecycle");
    context.subscriptions.push(collection);
    // Per lifecycle csv: the states csv it uses and the problems found in it
    const statesProblems = new Map<string, { states: Uri; diagnostics: Diagnostic[] }>();
    const timers = new Map<string, NodeJS.Timeout>();

    const severity = { error: DiagnosticSeverity.Error, warning: DiagnosticSeverity.Warning, info: DiagnosticSeverity.Information };

    const publishStates = (states: Uri) => {
        const entries = [...statesProblems.values()].filter((e) => e.states.toString() === states.toString());
        const seen = new Set<string>();
        const merged = entries
            .flatMap((e) => e.diagnostics)
            .filter((d) => {
                const key = `${d.range.start.line}|${d.message}`;
                return !seen.has(key) && seen.add(key);
            });
        collection.set(states, merged);
    };

    const refresh = async (document: TextDocument) => {
        const version = document.version;
        const related = await relatedFiles(document.uri);
        const statesText = related.states ? await readText(related.states) : null;
        if (document.isClosed || document.version !== version) {
            // A newer refresh is scheduled
            return;
        }
        const states = statesText !== null ? parseStatesCsv(statesText) : undefined;
        const lifecycle = parseLifecycleCsv(document.getText(), states);
        const own: Diagnostic[] = [];
        const inStates: Diagnostic[] = [];
        for (const issue of lint(lifecycle, states)) {
            const line = issue.line ?? 0;
            const table = issue.inStatesFile ? states?.table : lifecycle.table;
            const columnIndex = issue.column && table ? table.header.values.indexOf(issue.column) : -1;
            const range = new Range(line, 0, line, Number.MAX_SAFE_INTEGER);
            const diagnostic = new Diagnostic(range, columnIndex >= 0 ? `${issue.message} (${issue.column})` : issue.message, severity[issue.severity]);
            diagnostic.source = "lifecycle";
            diagnostic.code = issue.code;
            (issue.inStatesFile ? inStates : own).push(diagnostic);
        }
        collection.set(document.uri, own);
        const previous = statesProblems.get(document.uri.toString());
        if (related.states && statesText !== null) {
            statesProblems.set(document.uri.toString(), { states: related.states, diagnostics: inStates });
            publishStates(related.states);
        } else {
            statesProblems.delete(document.uri.toString());
        }
        if (previous && previous.states.toString() !== related.states?.toString()) {
            publishStates(previous.states);
        }
    };

    const schedule = (document: TextDocument) => {
        if (document.uri.scheme !== "file" || !isLifecycleDocument(document)) {
            return;
        }
        const key = document.uri.toString();
        clearTimeout(timers.get(key));
        timers.set(key, setTimeout(() => {
            timers.delete(key);
            void refresh(document);
        }, 250));
    };

    workspace.textDocuments.forEach(schedule);
    context.subscriptions.push(
        workspace.onDidOpenTextDocument(schedule),
        workspace.onDidChangeTextDocument((e) => {
            schedule(e.document);
            // A change in a states csv affects the lifecycles using it
            for (const [lifecycle, entry] of statesProblems) {
                if (entry.states.toString() === e.document.uri.toString()) {
                    const doc = workspace.textDocuments.find((d) => d.uri.toString() === lifecycle);
                    if (doc) {
                        schedule(doc);
                    }
                }
            }
        }),
        workspace.onDidCloseTextDocument((d) => {
            collection.delete(d.uri);
            const entry = statesProblems.get(d.uri.toString());
            if (entry) {
                statesProblems.delete(d.uri.toString());
                publishStates(entry.states);
            }
        }),
    );
}

export function registerLifecycleStudio(context: ExtensionContext): void {
    context.subscriptions.push(
        window.registerCustomEditorProvider(VIEW_TYPE, new LifecycleStudioProvider(context), {
            webviewOptions: { retainContextWhenHidden: true },
        }),
        commands.registerCommand("inmanta.openLifecycleStudio", async (uri?: Uri) => {
            const target = uri ?? window.activeTextEditor?.document.uri;
            if (target === undefined) {
                void window.showInformationMessage("Open a lifecycle csv first");
                return;
            }
            await commands.executeCommand("vscode.openWith", target, VIEW_TYPE);
        }),
        commands.registerCommand("inmanta.openLifecycleCsvAsText", async (uri?: Uri) => {
            const target = uri ?? window.activeTextEditor?.document.uri;
            if (target !== undefined) {
                await commands.executeCommand("vscode.openWith", target, "default");
            }
        }),
    );
    registerDiagnostics(context);
}
