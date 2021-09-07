import * as path from 'path';

import { runTests } from 'vscode-test';
import * as fs from 'fs-extra';
import * as rimraf from 'rimraf';


async function main() {

	const tmpHomeDir: string = fs.mkdtempSync("/tmp/vscode-tests");
	try {
		// The folder containing the Extension Manifest package.json
		// Passed to `--extensionDevelopmentPath`
		const extensionDevelopmentPath = path.resolve(__dirname, '../../');

		// Ensure the tests don't pick up any config present in the .config
		// in the home dir.
		const extensionTestsEnv = {
			HOME: tmpHomeDir,  // eslint-disable-line @typescript-eslint/naming-convention
			INMANTA_LANGUAGE_SERVER_PATH: process.env.INMANTA_LANGUAGE_SERVER_PATH  // eslint-disable-line @typescript-eslint/naming-convention
		};
		// Download VS Code, unzip it and run the integration test
		await runTests({
			extensionDevelopmentPath: extensionDevelopmentPath,
			extensionTestsPath: path.resolve(__dirname, './compile/index'),
			launchArgs: [path.resolve(__dirname, '../../src/test/compile/workspace'), "--disable-gpu"],
			extensionTestsEnv
		});
		await runTests({
			extensionDevelopmentPath: extensionDevelopmentPath,
			extensionTestsPath: path.resolve(__dirname, './loadExtension/index'),
			launchArgs: ["--disable-gpu"],
			extensionTestsEnv
		});
		await runTests({ 
			extensionDevelopmentPath: extensionDevelopmentPath, 
			extensionTestsPath: path.resolve(__dirname, './navigation/index'),
			launchArgs: [path.resolve(__dirname, '../../src/test/navigation/workspace'), "--disable-gpu"],
			extensionTestsEnv
		});
		
	} catch (err) {
		console.error('Failed to run tests: ' + err);
		process.exit(1);
	} finally {
		rimraf.sync(tmpHomeDir);
	}
}

main();
