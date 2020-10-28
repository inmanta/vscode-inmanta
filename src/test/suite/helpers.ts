import * as vscode from 'vscode';
import * as path from 'path';

export let doc: vscode.TextDocument;
export let editor: vscode.TextEditor;
export let documentEol: string;
export let platformEol: string;

/**
 * Activates the vscode.lsp-sample extension
 */
export async function activate(docUri: vscode.Uri) {
    // The extensionId is `publisher.name` from package.json
    const ext: vscode.Extension<any> = vscode.extensions.getExtension('Inmanta.inmanta')!;
    await ext.activate();
    try {
        doc = await vscode.workspace.openTextDocument(docUri);
        editor = await vscode.window.showTextDocument(doc);
        await sleep(60000);
    } catch (e) {
        console.error(e);
    }
}

async function sleep(ms: number) {
    await new Promise(resolve => setTimeout(resolve, ms));
}