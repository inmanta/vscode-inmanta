import * as path from 'path';
import * as cp from 'child_process';
import { downloadAndUnzipVSCode, resolveCliPathFromVSCodeExecutablePath, runTests } from '@vscode/test-electron';
import * as fs from 'fs-extra';
import * as rimraf from 'rimraf';


async function main() {

	const tmpHomeDir: string = fs.mkdtempSync("/tmp/vscode-tests");
	try {
		const settings = {
			"inmanta.ls.enabled": true,
		};

		// Saving settings of testing workspace to file
		const workspaceSettingsPath = path.resolve(__dirname, '../../src/test/compile/workspace/.vscode/settings.json');
		await fs.ensureFile(workspaceSettingsPath);
		await fs.writeJSON(workspaceSettingsPath, settings);
		const navworkspaceSettingsPath = path.resolve(__dirname, '../../src/test/navigation/workspace/.vscode/settings.json');
		await fs.ensureFile(navworkspaceSettingsPath);
		await fs.writeJSON(navworkspaceSettingsPath, settings);

		// The folder containing the Extension Manifest package.json
		// Passed to `--extensionDevelopmentPath`
		const extensionDevelopmentPath = path.resolve(__dirname, '../../');

		// Ensure the tests don't pick up any config present in the .config
		// in the home dir.
		const extensionTestsEnv = {
			HOME: tmpHomeDir,  // eslint-disable-line @typescript-eslint/naming-convention
			INMANTA_LANGUAGE_SERVER_PATH: process.env.INMANTA_LANGUAGE_SERVER_PATH  // eslint-disable-line @typescript-eslint/naming-convention
		};

		const vscodeExecutablePath = await downloadAndUnzipVSCode('1.50.0');
    	const cliPath = resolveCliPathFromVSCodeExecutablePath(vscodeExecutablePath);
		cp.spawnSync(cliPath, ['--install-extension', 'ms-python.python', "--list-extensions","--show-versions"], {
			encoding: 'utf-8',
			stdio: 'inherit'
		  });

		//run the integration test
		await runTests({
			vscodeExecutablePath,
			extensionDevelopmentPath,
			extensionTestsPath: path.resolve(__dirname, './compile/index'),
			launchArgs: [],
			extensionTestsEnv
		});
		// await runTests({
		// 	extensionDevelopmentPath: extensionDevelopmentPath,
		// 	extensionTestsPath: path.resolve(__dirname, './loadExtension/index'),
		// 	launchArgs: ["--disable-gpu"],
		// 	extensionTestsEnv
		// });
		// await runTests({
		// 	extensionDevelopmentPath: extensionDevelopmentPath,
		// 	extensionTestsPath: path.resolve(__dirname, './navigation/index'),
		// 	launchArgs: [path.resolve(__dirname, '../../src/test/navigation/workspace'), "--disable-gpu"],
		// 	extensionTestsEnv
		// });

	} catch (err) {
		console.error('Failed to run tests: ' + err);
		process.exit(1);
	} finally {
		rimraf.sync(tmpHomeDir);
	}
}

main();
