import * as path from 'path';
import * as cp from 'child_process';
import { downloadAndUnzipVSCode, resolveCliPathFromVSCodeExecutablePath, runTests } from '@vscode/test-electron';
import * as fs from 'fs-extra';
import * as rimraf from 'rimraf';

async function main() {
	const tmpHomeDir: string = fs.mkdtempSync("/tmp/vscode-tests");
	try {
		console.info("=================================== TEST SUITE STARTED =============================================");

		// The folder containing the Extension Manifest package.json
		const extensionDevelopmentPath = path.resolve(__dirname, '../../');

		// Ensure the tests don't pick up any config present in the .config
		// in the home dir.
		const vscodeExecutablePath = await downloadAndUnzipVSCode('stable');
		const cliPath = resolveCliPathFromVSCodeExecutablePath(vscodeExecutablePath, "linux-x64");
		console.warn('[DEBUG] CLI path:', cliPath);

		// Install Python extension to the user extensions directory
		// and specify the extensions directory in the environment
		const userExtensionsDir = path.join(tmpHomeDir, '.vscode/extensions');
		await fs.ensureDir(userExtensionsDir);

		console.info('[DEBUG] Temporary Home Directory:', tmpHomeDir);
		console.info('[DEBUG] User Extensions Directory:', userExtensionsDir);

		// Install Python extension to the temporary user directory
		cp.spawnSync(cliPath, [
			'--install-extension',
			'ms-python.python',
			'--force'
		], {
			encoding: 'utf-8',
			stdio: 'inherit',
			env: {
				...process.env,
				VSCODE_EXTENSIONS: userExtensionsDir
			}
		});

		// Add the extensions directory to the environment
		const extensionTestsEnv = {
			HOME: tmpHomeDir,
			VSCODE_EXTENSIONS: userExtensionsDir,
		};

		await runTests({
			vscodeExecutablePath,
			extensionDevelopmentPath: extensionDevelopmentPath,
			extensionTestsPath: path.resolve(__dirname, './installExtension/index'),
			launchArgs: [
				path.resolve(__dirname, '../../src/test/installExtension/workspace'),
				"--extensions-dir",
				userExtensionsDir,
				"--disable-gpu"
			],
			extensionTestsEnv,
			reuseMachineInstall: true,
		});
	} catch (err) {
		console.error('Failed to run tests: ' + err);
		process.exit(1);
	} finally {
		rimraf.sync(tmpHomeDir);
	}
}

main();
