import * as path from 'path';

import { runTests } from 'vscode-test';
import * as fs from 'fs-extra';

async function main() {

	const tmpHomeDir: string = fs.mkdtempSync("/tmp/vscode-tests");
	try {
		// Loading config of testing workspace
		const pythonPath = process.env.INMANTA_PYTHON_PATH;
		if (pythonPath === undefined) {
			throw new Error("INMANTA_PYTHON_PATH has to be set");
		}

		const settings = {
			"inmanta.ls.enabled": true,
			"inmanta.pythonPath": pythonPath
		};

		// Saving settings of testing workspace to file
		const workspaceSettingsPath = path.resolve(__dirname, '../../src/test/workspace/.vscode/settings.json');
		await fs.ensureFile(workspaceSettingsPath);
		await fs.writeJSON(workspaceSettingsPath, settings);

		// The folder containing the Extension Manifest package.json
		// Passed to `--extensionDevelopmentPath`
		const extensionDevelopmentPath = path.resolve(__dirname, '../../');

		// Ensure the tests don't pick up any config present in the .config
		// in the home dir.
		const extensionTestsEnv = {HOME: tmpHomeDir};
		// Download VS Code, unzip it and run the integration test
		await runTests({
			extensionDevelopmentPath: extensionDevelopmentPath,
			extensionTestsPath: path.resolve(__dirname, './suite/indexCompileTest'),
			extensionTestsEnv
		});
		await runTests({
			extensionDevelopmentPath: extensionDevelopmentPath,
			extensionTestsPath: path.resolve(__dirname, './suite/indexLoadExtension'),
			extensionTestsEnv
		});
	} catch (err) {
		console.error('Failed to run tests: ' + err);
		process.exit(1);
	} finally {
		fs.rmdirSync(tmpHomeDir, {recursive: true});
	}
}

main();
