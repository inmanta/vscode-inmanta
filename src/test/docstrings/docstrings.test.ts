import * as assert from 'assert';
import { after, describe, it, beforeEach } from 'mocha';
import * as path from 'path';
import * as fs from 'fs-extra';

import { Uri, window, commands, workspace, TextDocument, Position} from 'vscode';
import { waitForCompile } from '../helpers';

const logPath: string = process.env.INMANTA_LS_LOG_PATH || '/tmp/vscode-inmanta.log';
const workspaceUri: Uri = Uri.file(path.resolve(__dirname, '../../../src/test/docstrings/workspace'));

const modelUri: Uri = Uri.file(path.resolve(workspaceUri.fsPath, 'main.cf'));

describe('Language Server Code docstrings', () => {

	beforeEach(async () => {
		await commands.executeCommand('workbench.action.closeActiveEditor');
	});

	it(`Check that docstings work`, () => {
		return new Promise<void>(async resolve => {
			// Open model file
			console.log("________test1");
			const doc: TextDocument = await workspace.openTextDocument(modelUri);
			await window.showTextDocument(doc);
			const succeeded = await waitForCompile(logPath, 25000);
			console.log("________test2");
			assert.strictEqual(succeeded, true, "Compilation didn't succeed");
			console.log("________test3");
			const docstringEntity1 = await commands.executeCommand("vscode.executeHoverProvider", modelUri, new Position(18, 11));
			const docstringEntity2 = await commands.executeCommand("vscode.executeHoverProvider", modelUri, new Position(44, 16));
			const docstringPlugin = await commands.executeCommand("vscode.executeHoverProvider", modelUri, new Position(22, 14));

			console.log("1: " + JSON.stringify(docstringEntity1));
			console.log("2: " + JSON.stringify(docstringEntity2));
			console.log("3: " + JSON.stringify(docstringPlugin));
			console.log("________test4");
			resolve();
		});
	}).timeout(0);


	after(async () => {
		await Promise.all([
			fs.writeFile(logPath, ""),
		]);
	});
});
