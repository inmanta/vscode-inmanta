import * as path from 'path';

import { runTests } from 'vscode-test';
import * as fs from 'fs-extra';


async function main() {

	try {
		const settings = {
			"inmanta.ls.enabled": true,
		};

		if (process.env.INMANTA_PYTHON_PATH) {
			settings["inmanta.pythonPath"] = process.env.INMANTA_PYTHON_PATH;
		}

		if (process.env.INMANTA_COMPILER_VENV) {
			settings["inmanta.compilerVenv"] = process.env.INMANTA_COMPILER_VENV;
		}

		// Saving settings of testing workspace to file
		const workspaceSettingsPath = path.resolve(__dirname, '../../src/test/workspace/.vscode/settings.json');
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
			extensionTestsEnv: {
				"INMANTA_LANGUAGE_SERVER_PATH": process.env.INMANTA_LANGUAGE_SERVER_PATH,
			},
		});
	} catch (err) {
		console.error('Failed to run tests: ' + err);
		process.exit(1);
	}
}

main();
