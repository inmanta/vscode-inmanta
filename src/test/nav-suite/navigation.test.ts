import * as assert from 'assert';
import { after, before, describe, it, beforeEach } from 'mocha';
import * as path from 'path';
import * as fs from 'fs-extra';

import { Uri, window, commands, workspace, TextDocument, TextEditor, Position, SnippetString, extensions, Range, Location } from 'vscode';

const logPath: string = '/tmp/vscode-inmanta.log';
const workspaceUri: Uri = Uri.file(path.resolve(__dirname, '../../../src/test/navigation-workspace'));
const libsPath: string = path.resolve(workspaceUri.fsPath, 'libs');


const modelUri: Uri = Uri.file(path.resolve(workspaceUri.fsPath, 'main.cf'));

function waitForCompile(timeout: number): Promise<boolean> {
	const start = Date.now();
	return new Promise<boolean>((resolve, reject) => {
		const readLogInterval = setInterval(() => {
			if (Date.now() - start > timeout) {
				reject(new Error("Timeout reached"));
			} else {
				fs.ensureFileSync(logPath);
				fs.readFile(logPath, 'utf-8', (err, data) => {
					if (err) {
						console.log(err);
					} else if (data.includes('Compilation succeeded')) {
						clearInterval(readLogInterval);
						resolve(true);
					} else if (data.includes('Compilation failed')) {
						clearInterval(readLogInterval);
						resolve(false);
					}
				});
			}
		}, 500);
	});
}

describe('Language Server Code navigation', () => {

	beforeEach(async () => {
		await Promise.all([
			fs.writeFile(logPath, ""),
		]).then(async values => {
			await commands.executeCommand('workbench.action.closeActiveEditor');
		});
	});

	
	it(`Check that code navigation works`, () => {
		return new Promise(async (resolve, reject) => {			
			// Wait one second to let vscode notice we closed the previous editor
			
			await new Promise(res => setTimeout(res, 1000));
			

			// Open model file
			const doc: TextDocument = await workspace.openTextDocument(modelUri);
			await window.showTextDocument(doc);
			const succeeded = await waitForCompile(10000);
			assert.strictEqual(succeeded, true, "Compilation didn't succeed");
			const attributeInSameFile = await commands.executeCommand("vscode.executeDefinitionProvider", modelUri, new Position(13, 16));
			
			assert.strictEqual((attributeInSameFile as Location[]).length, 1);
			assert.strictEqual(attributeInSameFile[0].uri.fsPath, modelUri.fsPath);
			assert.deepStrictEqual(attributeInSameFile[0].range, new Range(new Position(2, 11), new Position(2, 15)), "Attribute location in the same file doesn't match");

			const typeInDifferentFile = await commands.executeCommand("vscode.executeDefinitionProvider", modelUri, new Position(4, 18));
			assert.strictEqual((typeInDifferentFile as Location[]).length, 1);
			assert.strictEqual(typeInDifferentFile[0].uri.fsPath, Uri.file(path.resolve(libsPath, "testmodule", "model", "_init.cf")).fsPath);
			assert.deepStrictEqual(typeInDifferentFile[0].range, new Range(new Position(0, 8), new Position(0, 11)), "Attribute location in different file doesn't match");
			const pluginInDifferentFile = await commands.executeCommand("vscode.executeDefinitionProvider", modelUri, new Position(17, 15));
			assert.strictEqual((pluginInDifferentFile as Location[]).length, 1);
			assert.strictEqual(pluginInDifferentFile[0].uri.fsPath, Uri.file(path.resolve(libsPath, "testmodule", "plugins", "__init__.py")).fsPath);
			assert.deepStrictEqual(pluginInDifferentFile[0].range, new Range(new Position(4, 0), new Position(5, 0)), "Plugin location doesn't match");
			
			resolve();
		});
	}).timeout(0);
	

	after(async () => {
		await Promise.all([
			// fs.writeFile(logPath, ""),
		]);
	});
});
