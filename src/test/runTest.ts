import * as path from 'path';

import { runTests } from 'vscode-test';
import * as fs from 'fs-extra';

async function main() {

	try {
		// Loading config of testing workspace
		const pythonPath = process.env.INMANTA_PYTHON_PATH;
		const compilerVenv = process.env.INMANTA_COMPILER_VENV;
		if (pythonPath === undefined) throw new Error("INMANTA_PYTHON_PATH has to be set");
		if (compilerVenv === undefined) throw new Error("INMANTA_COMPILER_VENV has to be set");

		const settings = {
			"inmanta.ls.enabled": true,
			"inmanta.pythonPath": pythonPath,
			"inmanta.compilerVenv": compilerVenv
		}

		// Saving settings of testing workspace to file
		const workspaceSettingsPath = path.resolve(__dirname, './workspace/.vscode/settings.json');
		await fs.ensureFile(workspaceSettingsPath);
		await fs.writeJSON(workspaceSettingsPath, settings);

		// The folder containing the Extension Manifest package.json
		// Passed to `--extensionDevelopmentPath`
		const extensionDevelopmentPath = path.resolve(__dirname, '../../');

		// The path to test runner
		// Passed to --extensionTestsPath
		const extensionTestsPath = path.resolve(__dirname, './suite/index');

		// Download VS Code, unzip it and run the integration test
		await runTests({ 
			extensionDevelopmentPath: extensionDevelopmentPath, 
			extensionTestsPath: extensionTestsPath,
		});
	} catch (err) {
		console.error('Failed to run tests: ' + err);
		process.exit(1);
	}
}

main();
