import * as assert from 'assert';
import { after, before, describe, it, beforeEach } from 'mocha';
import * as path from 'path';
import * as fs from 'fs-extra';

import { Uri, window, commands, workspace, TextDocument, TextEditor, Position, SnippetString } from 'vscode';

const logPath: string = '/tmp/vscode-inmanta.log';
const workspaceUri: Uri = Uri.file(path.resolve(__dirname, '../../../src/test/workspace'));
const libsPath: string = path.resolve(workspaceUri.fsPath, 'libs');
const envPath: string = path.resolve(workspaceUri.fsPath, '.env');

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

describe('Compile checks', () => {
	const tests = [
		{ source: 'valid.cf', succeed: true },
		{ source: 'invalid.cf', succeed: false }
	];

	before((done) => {
		commands.executeCommand('vscode.openFolder', workspaceUri).then(done);
	});

	beforeEach((done) => {
		Promise.all([
			fs.writeFile(logPath, ""),
			fs.remove(libsPath),
			fs.remove(envPath),
			fs.remove(modelUri.fsPath),
		]).then(async values => {
			await commands.executeCommand('workbench.action.closeActiveEditor');
			done();
		});
	});

	tests.forEach(test => {
		it(`Check that ${test.source} ${test.succeed ? "does" : "doesn't"} compile`, () => {
			return new Promise(async resolve => {
				// Copy model into main.cf
				const source: string = path.resolve(workspaceUri.fsPath, test.source);
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

				const succeeded = await waitForCompile(10000);
				assert.strictEqual(succeeded, test.succeed);

				const libsExists = fs.pathExistsSync(libsPath);
				assert.strictEqual(libsExists, true, "The libs folder hasn't been created");

				const envExists = fs.pathExistsSync(envPath);
				assert.strictEqual(envExists, true, "The .env folder hasn't been created");

				resolve();
			});
		}).timeout(0);
	});

	after((done) => {
		Promise.all([
			fs.writeFile(logPath, ""),
			fs.remove(libsPath),
			fs.remove(envPath),
			fs.remove(modelUri.fsPath),
		]).then(values => {
			done();
		});
	});
});
