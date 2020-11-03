import * as assert from 'assert';
import { after, before, describe, it, beforeEach } from 'mocha';
import * as path from 'path';
import * as fs from 'fs-extra';

import { Uri, window, commands, workspace, TextDocument, TextEditor, Position, SnippetString, extensions } from 'vscode';

import { waitForCompile, compareVersions, getInstalledPackages } from './helpers';


const logPath: string = '/tmp/vscode-inmanta.log';
const workspaceUri: Uri = Uri.file(path.resolve(__dirname, '../../../src/test/workspace'));
const modelUri: Uri = Uri.file(path.resolve(workspaceUri.fsPath, 'main.cf'));

let inmantaVersion: string = undefined;


describe('Extension virtual environment check', () => {

	before(async function () {
		this.timeout(0);
		await Promise.all([
			commands.executeCommand('vscode.openFolder', workspaceUri),
			fs.writeFile(logPath, ""),
			fs.remove(modelUri.fsPath),
		]);
		await commands.executeCommand('workbench.action.closeActiveEditor');

		// Copy model into main.cf
		const source: string = path.resolve(workspaceUri.fsPath, 'valid.cf');
		await fs.copyFile(source, modelUri.fsPath);
		
		// Wait one second to let vscode notice we closed the previous editor
		await new Promise(resolve => setTimeout(resolve, 1000));

		// Opening model file
		const doc: TextDocument = await workspace.openTextDocument(modelUri);
		const edit: TextEditor = await window.showTextDocument(doc);

		// Making file dirty and save it
		const position: Position = new Position(0, 0);
		const snippet: SnippetString = new SnippetString("\n");
		await edit.insertSnippet(snippet, position);
		assert.strictEqual(doc.isDirty, true, "The file should be dirty, but isn't");
		await doc.save();

		const succeeded = await waitForCompile(logPath, 10000);
		assert.strictEqual(succeeded, true);
	});

	it(`Checking that the extension installed the Language Server`, async () => {
		const installedPackages = await getInstalledPackages(process.env.INMANTA_PYTHON_PATH);

		let foundInmanta = false;
		let foundInmantals = false;

		for (let i = 0; i < installedPackages.length; i++) {
			const installedPackage = installedPackages[i];
			if (installedPackage["name"] === "inmanta") {
				foundInmanta = true;
				inmantaVersion = installedPackage["version"];
			} else if (installedPackage["name"] === "inmantals") {
				foundInmantals = true;
			}
		}

		// Checking that the server has been installed in the provided python environment
		assert.strictEqual(foundInmantals, true, 'Package "inmantals" has not been installed in the referenced python environment.');

		// Checking that inmanta has been installed in the provided python environment
		assert.strictEqual(foundInmanta, true, 'Package "inmanta" has not been installed in the referenced python environment.');
	});

	after((done) => {
		Promise.all([
			fs.writeFile(logPath, ""),
			fs.remove(modelUri.fsPath),
		]).then(values => {
			done();
		});
	});
});


describe('Compiler virtual environment check', () => {
	if (inmantaVersion === undefined) {
		console.warn("Could not determine inmanta version, skipping compiler env tests.");
		return;
	}
	const envPath: string = compareVersions(inmantaVersion, "2020.5") <= 0
		? path.resolve(workspaceUri.fsPath, '.env') 
		: process.env.INMANTA_COMPILER_VENV;

	before(async function () {
		this.timeout(0);
		await Promise.all([
			commands.executeCommand('vscode.openFolder', workspaceUri),
			fs.writeFile(logPath, ""),
			fs.remove(envPath),
			fs.remove(modelUri.fsPath),
		]);
		await commands.executeCommand('workbench.action.closeActiveEditor');

		// Copy model into main.cf
		const source: string = path.resolve(workspaceUri.fsPath, 'valid.cf');
		await fs.copyFile(source, modelUri.fsPath);
		
		// Wait one second to let vscode notice we closed the previous editor
		await new Promise(resolve => setTimeout(resolve, 1000));

		// Opening model file
		const doc: TextDocument = await workspace.openTextDocument(modelUri);
		const edit: TextEditor = await window.showTextDocument(doc);

		// Making file dirty and save it
		const position: Position = new Position(0, 0);
		const snippet: SnippetString = new SnippetString("\n");
		await edit.insertSnippet(snippet, position);
		assert.strictEqual(doc.isDirty, true, "The file should be dirty, but isn't");
		await doc.save();

		const succeeded = await waitForCompile(logPath, 10000);
		assert.strictEqual(succeeded, true);
	});

	it(`Checking that the compiler created the virtual environment folder`, async () => {
		const libsExists = fs.pathExistsSync(envPath);
		assert.strictEqual(libsExists, true, `The virtual environment folder (${envPath})hasn't been created`);
	});

	after((done) => {
		Promise.all([
			fs.writeFile(logPath, ""),
			fs.remove(envPath),
			fs.remove(modelUri.fsPath),
		]).then(values => {
			done();
		});
	});
});
