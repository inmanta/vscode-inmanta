import * as assert from 'assert';
import { after, it } from 'mocha';
import * as path from 'path';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import { Uri, window, commands, extensions, Extension, workspace, TextDocument } from 'vscode';
// import * as myExtension from '../../extension';
import { activate } from './helpers'


suite('Model compile tests', () => {
	window.showInformationMessage('Start compile tests.');

	after(() => {
		window.showInformationMessage('All tests done!');
	});

	test('Valid model test', async () => {
		const workspaceUri: Uri = Uri.file(path.resolve(__dirname, '../../../src/test/workspace/'))
		const modelUri: Uri = Uri.file(path.resolve(workspaceUri.fsPath, 'main.cf'));

		const folder = await commands.executeCommand('vscode.openFolder', workspaceUri);
		const doc: TextDocument = await workspace.openTextDocument(modelUri);
		await doc.save()
		const editor = await window.showTextDocument(doc);

		await new Promise(resolve => setTimeout(resolve, 10000));
	}).timeout(0);
});

suite('CTRL + Click tests', () => {

});

suite('Venv installation tests', () => {

});