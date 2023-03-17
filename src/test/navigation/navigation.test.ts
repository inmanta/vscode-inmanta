import * as assert from 'assert';
import { after, describe, it, beforeEach } from 'mocha';
import * as path from 'path';
import * as fs from 'fs-extra';

import { Uri, window, commands, workspace, TextDocument, Position, Range, Location } from 'vscode';
import { waitForCompile } from '../helpers';

const logPath: string = process.env.INMANTA_LS_LOG_PATH || '/tmp/vscode-inmanta.log';
const workspaceUri: Uri = Uri.file(path.resolve(__dirname, '../../../src/test/navigation/workspace'));
const libsPath: string = path.resolve(workspaceUri.fsPath, 'libs');

const modelUri: Uri = Uri.file(path.resolve(workspaceUri.fsPath, 'main.cf'));

describe('Language Server Code navigation', () => {

	beforeEach(async () => {
		await commands.executeCommand('workbench.action.closeActiveEditor');
	});

	it(`Check that code navigation works`, () => {
		return new Promise<void>(async resolve => {
			// Open model file
			const doc: TextDocument = await workspace.openTextDocument(modelUri);
			await window.showTextDocument(doc);
			const succeeded = await waitForCompile(logPath, 25000);
			assert.strictEqual(succeeded, true, "Compilation didn't succeed");

			const attributeInSameFile = await commands.executeCommand("vscode.executeHoverProvider", modelUri, new Position(13, 16));
			let expectedAttributeLocation = new Range(new Position(2, 11), new Position(2, 15));
			assert.strictEqual((attributeInSameFile as Location[]).length, 1);
			assert.strictEqual(attributeInSameFile[0].uri.fsPath, modelUri.fsPath);
			assert.deepStrictEqual(attributeInSameFile[0].range, expectedAttributeLocation, "Attribute location in the same file doesn't match");

			const typeInDifferentFile = await commands.executeCommand("vscode.executeDefinitionProvider", modelUri, new Position(4, 18));
			assert.strictEqual((typeInDifferentFile as Location[]).length, 1);
			assert.strictEqual(typeInDifferentFile[0].uri.fsPath, path.resolve(libsPath, "testmodule", "model", "_init.cf"));
			assert.deepStrictEqual(typeInDifferentFile[0].range, new Range(new Position(0, 8), new Position(0, 11)), "Attribute location in different file doesn't match");

			const pluginLocation = await commands.executeCommand("vscode.executeDefinitionProvider", modelUri, new Position(17, 15));
			assert.strictEqual((pluginLocation as Location[]).length, 1);
			assert.strictEqual(pluginLocation[0].uri.fsPath, path.resolve(libsPath, "testmodule", "plugins", "__init__.py"));
			assert.deepStrictEqual(pluginLocation[0].range, new Range(new Position(4, 0), new Position(5, 0)), "Plugin location doesn't match");
			resolve();
		});
	}).timeout(0);


	after(async () => {
		await Promise.all([
			fs.writeFile(logPath, ""),
		]);
	});
});
