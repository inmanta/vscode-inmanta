import * as assert from 'assert';
import { after, before } from 'mocha';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as readline from 'readline';

import { Uri, window, commands, workspace, TextDocument } from 'vscode';


suite('Model compile tests', () => {
	window.showInformationMessage('Start compile tests.');

	const workspaceUri: Uri = Uri.file(path.resolve(__dirname, '../../../src/test/workspace/'));
	const libsPath: string = path.resolve(workspaceUri.fsPath, 'libs');
	const envPath: string = path.resolve(workspaceUri.fsPath, '.env');

	const logPath: string = '/tmp/vscode-inmanta.log'

	before(() => {
		console.log("Preparing test, cleaning out...");

		// Ensuring project is clean
		fs.removeSync(libsPath);
		fs.removeSync(envPath);

		// Removing log file
		fs.removeSync(logPath)
	});

	test('Valid model test', async () => {
		
		const modelUri: Uri = Uri.file(path.resolve(workspaceUri.fsPath, 'main.cf'));

		const folder = await commands.executeCommand('vscode.openFolder', workspaceUri);

		fs.ensureFileSync(logPath);

		const readInterface = readline.createInterface({
			input: fs.createReadStream(logPath)
		});
		
		const doc: TextDocument = await workspace.openTextDocument(modelUri);
		const editor = await window.showTextDocument(doc);

		// Waiting for the compilation to happen
		await new Promise(async resolve => {
			const readLogInterval = setInterval(() => {
				fs.readFile(logPath, 'utf-8', (err, data) => {
					if (err) {
						console.log(err);
					} else if (data.includes('Compile succeeded')) {
						clearInterval(readLogInterval);
						resolve();
					} else if (data.includes('Compile failed')) {
						clearInterval(readLogInterval);
						assert.strictEqual(false, true, "The compilation failed");
						resolve();
					}
				});
			}, 500);
		});

		const libsExists = fs.pathExistsSync(libsPath);
		assert.strictEqual(libsExists, true, "The libs folder hasn't been created");

		const envExists = fs.pathExistsSync(envPath);
		assert.strictEqual(envExists, true, "The .env folder hasn't been created");
	}).timeout(0);

	after(() => {
		window.showInformationMessage('All tests done!');
		console.log("Tests done, cleaning out...");

		// Clean out created directories
		fs.removeSync(libsPath);
		fs.removeSync(envPath);
	});
});

suite('CTRL + Click tests', () => {

});

suite('Venv installation tests', () => {

});
