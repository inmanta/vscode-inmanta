import * as assert from 'assert';
import { after, describe, it, beforeEach } from 'mocha';
import * as path from 'path';
import * as fs from 'fs-extra';

import { Uri, window, commands, workspace, TextDocument, Position } from 'vscode';
import { waitForCompile } from '../helpers';

const logPath: string = process.env.INMANTA_LS_LOG_PATH || '/tmp/vscode-inmanta.log';
const workspaceUri: Uri = Uri.file(path.resolve(__dirname, '../../../src/test/docstrings/workspace'));

const modelUri: Uri = Uri.file(path.resolve(workspaceUri.fsPath, 'main.cf'));

describe('Language Server Code docstrings', () => {

	beforeEach(async () => {
		await commands.executeCommand('workbench.action.closeActiveEditor');
	});

	it(`Check that docstrings work`, () => {
		return new Promise<void>(async resolve => {
			// Open model file
			const doc: TextDocument = await workspace.openTextDocument(modelUri);
			await window.showTextDocument(doc);
			const succeeded = await waitForCompile(logPath, 25000);
			assert.strictEqual(succeeded, true, "Compilation didn't succeed");
			const docstringEntity = await commands.executeCommand("vscode.executeHoverProvider", modelUri, new Position(13, 11));

			const expectedDocstringEntity: string = `
\`\`\`inmanta
entity Person:
\`\`\`

___
the&nbsp;entity&nbsp;for&nbsp;a&nbsp;Person`;
			assert.strictEqual(docstringEntity[0].contents[0].value, expectedDocstringEntity, "wrong docstring Entity");

			const docstringPlugin = await commands.executeCommand("vscode.executeHoverProvider", modelUri, new Position(21, 14));
			const expectedDocstringPlugin = `
\`\`\`python
def noop(message: "any"):
\`\`\`

___
blablabla&nbsp;nononop

:param&nbsp;message:a&nbsp;message

:return:&nbsp;nothing`;

			assert.strictEqual(docstringPlugin[0].contents[0].value, expectedDocstringPlugin, "wrong docstring Plugin");


			const weirdDocstringEntity = await commands.executeCommand("vscode.executeHoverProvider", modelUri, new Position(43, 14));
			const expectedWeirdDocstringEntity = `
\`\`\`inmanta
entity EntityWeirdDoc:
\`\`\`

___
This&nbsp;is:



&nbsp;&nbsp;&nbsp;&nbsp;my&nbsp;docstring&nbsp;with&nbsp;some&nbsp;keywords&nbsp;like&nbsp;if&nbsp;for&nbsp;entity&nbsp;end&nbsp;0&nbsp;1&nbsp;2`;
			assert.strictEqual(weirdDocstringEntity[0].contents[0].value, expectedWeirdDocstringEntity, "wrong docstring Plugin");

			resolve();
		});
	}).timeout(0);


	after(async () => {
		await Promise.all([
			fs.writeFile(logPath, "done"),
		]);
	});
});
