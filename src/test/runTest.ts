import * as path from 'path';
import * as cp from 'child_process';
import { downloadAndUnzipVSCode, resolveCliPathFromVSCodeExecutablePath, runTests } from '@vscode/test-electron';
import * as fs from 'fs-extra';
import * as rimraf from 'rimraf';

async function main() {
	const tmpHomeDir: string = fs.mkdtempSync("/tmp/vscode-tests");
	try {
		console.info("=================================== TEST SUITE STARTED =============================================");

		// Parse command line arguments
		const args = process.argv.slice(2);
		const useVsix = args.includes('--vsix');
		const vsixPath = args[args.indexOf('--vsix') + 1];

		if (useVsix && !vsixPath) {
			console.error('Please provide the path to the VSIX file when using --vsix flag');
			process.exit(1);
		}
		if (useVsix && !fs.existsSync(vsixPath)) {
			console.error(`VSIX file not found at: ${vsixPath}`);
			process.exit(1);
		}

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

		// Create logs directory in the extension development path
		const logsDir = path.join(extensionDevelopmentPath, 'logs');
		await fs.ensureDir(logsDir);
		console.info('[DEBUG] Logs Directory:', logsDir);

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

		if (useVsix) {
			// Install the VSIX file
			console.info(`Installing VSIX file from: ${vsixPath}`);
			cp.spawnSync(cliPath, [
				'--install-extension',
				vsixPath,
				'--force'
			], {
				encoding: 'utf-8',
				stdio: 'inherit',
				env: {
					...process.env,
					VSCODE_EXTENSIONS: userExtensionsDir
				}
			});
		}

		// Add the extensions directory to the environment
		const extensionTestsEnv = {
			HOME: tmpHomeDir,
			VSCODE_EXTENSIONS: userExtensionsDir,
			INMANTA_LS_LOG_PATH: path.join(extensionDevelopmentPath, 'logs', 'server.log'),
		};

		await runTests({
			vscodeExecutablePath,
			extensionDevelopmentPath: useVsix ? undefined : extensionDevelopmentPath,
			extensionTestsPath: path.resolve(__dirname, './installExtension/index'),
			launchArgs: [
				path.resolve(__dirname, '../../src/test/installExtension/workspace'),
				"--extensions-dir",
				userExtensionsDir,
				"--disable-gpu",
				"--disable-telemetry",
				"--enable-proposed-api",
				"ms-python.python"
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
