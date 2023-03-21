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

	it(`Check that docstrings work`, () => {
		return new Promise<void>(async resolve => {
			// Open model file
			const doc: TextDocument = await workspace.openTextDocument(modelUri);
			await window.showTextDocument(doc);
			const succeeded = await waitForCompile(logPath, 25000);
			assert.strictEqual(succeeded, true, "Compilation didn't succeed");
			const docstringEntity = await commands.executeCommand("vscode.executeHoverProvider", modelUri, new Position(13, 11));
			const expectedDocstringEntity = `
\`\`\`inmanta
entity Person:
\`\`\`

___
the&nbsp;entity&nbsp;for&nbsp;a&nbsp;Person
`;
			assert.strictEqual(docstringEntity[0].contents[0].value, expectedDocstringEntity, "wrong docstring Entity");

			const docstringPlugin = await commands.executeCommand("vscode.executeHoverProvider", modelUri, new Position(21, 14));
			const expectedDocstringPlugin = `
\`\`\`python
def noop(message: "any"):
\`\`\`

___
returns&nbsp;the&nbsp;input

:param&nbsp;message:&nbsp;a&nbsp;message&nbsp;as&nbsp;input
`;
			assert.strictEqual(docstringPlugin[0].contents[0].value, expectedDocstringPlugin, "wrong docstring Entity");
			resolve();
		});
	}).timeout(0);


	after(async () => {
		await Promise.all([
			fs.writeFile(logPath, "done"),
		]);
	});
});
