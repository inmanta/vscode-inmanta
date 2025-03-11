import * as path from 'path';
import * as cp from 'child_process';
import { downloadAndUnzipVSCode, resolveCliPathFromVSCodeExecutablePath, runTests } from '@vscode/test-electron';
import * as fs from 'fs-extra';
import * as rimraf from 'rimraf';

async function main() {
	const tmpHomeDir: string = fs.mkdtempSync("/tmp/vscode-tests");
	try {
		console.info("Running tests");

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

		const docstringSettingsPath = path.resolve(__dirname, '../../src/test/docstrings/workspace/.vscode/settings.json');
		await fs.ensureFile(docstringSettingsPath);
		await fs.writeJSON(docstringSettingsPath, settings);

		// The folder containing the Extension Manifest package.json
		// Passed to `--extensionDevelopmentPath`
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
			DISPLAY: ':0',
		};

		// Run install extension tests first
		await runTests({
			vscodeExecutablePath,
			extensionDevelopmentPath: extensionDevelopmentPath,
			extensionTestsPath: path.resolve(__dirname, './installExtension/index'),
			launchArgs: [
				path.resolve(__dirname, '../../src/test/installExtension/workspace'),
				'--no-headless',
				"--extensions-dir", userExtensionsDir
			],
			extensionTestsEnv,
			reuseMachineInstall: true,
		});

		await runTests({
			vscodeExecutablePath,
			extensionDevelopmentPath: extensionDevelopmentPath,
			extensionTestsPath: path.resolve(__dirname, './loadExtension/index'),
			launchArgs: ["--disable-gpu"],
			extensionTestsEnv,
			reuseMachineInstall: true,
		});

		await runTests({
			vscodeExecutablePath,
			launchArgs: [path.resolve(__dirname, '../../src/test/compile/workspace'), "--disable-gpu"],
			extensionDevelopmentPath,
			extensionTestsPath: path.resolve(__dirname, './compile/index'),
			reuseMachineInstall: true,
		});

		await runTests({
			vscodeExecutablePath,
			extensionDevelopmentPath: extensionDevelopmentPath,
			extensionTestsPath: path.resolve(__dirname, './navigation/index'),
			launchArgs: [path.resolve(__dirname, '../../src/test/navigation/workspace'), "--disable-gpu"],
			reuseMachineInstall: true,
		});

		await runTests({
			vscodeExecutablePath,
			extensionDevelopmentPath: extensionDevelopmentPath,
			extensionTestsPath: path.resolve(__dirname, './docstrings/index'),
			launchArgs: [path.resolve(__dirname, '../../src/test/docstrings/workspace'), "--disable-gpu"],
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
