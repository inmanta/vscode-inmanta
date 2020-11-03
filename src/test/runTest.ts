import * as path from 'path';

import { runTests } from 'vscode-test';
import * as fs from 'fs-extra';
import { exec } from 'child_process';


/**
 * Query the version of inmanta installed in the provided python environment.
 * @param pythonPath the path to the python binary in the environment in which inmanta is installed
 * 
 * @returns a Promise resolving a string, the verison of inmanta found.
 */
async function getInmantaVersion(pythonPath: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		exec(`${pythonPath} -m pip list --format json`, (err, stdout, stderr) => {
			if (err) {
				reject(err);
			} else {
				const packageList = JSON.parse(stdout);
				packageList.forEach(element => {
					if (element.hasOwnProperty("name") && element["name"] === "inmanta" && element.hasOwnProperty("version")) {
						resolve(element["version"]);
					}
				});
				reject(new Error("Could not find inmanta in provided python environment."));
			}
		});
	});
}

/**
 * Compare two versions, returns positive integer if a > b, negative if b > a and 0 if a == b
 * @param a is a valid version, of format <year>.<release>[.<...>]
 * @param b is a valid version, of format <year>.<release>[.<...>]
 * 
 * @returns an integer, result of the comparison of the two versions
 */
function compareVersions(a: string, b: string): number {
	const splitedA = a.split(".");
	const splitedB = b.split(".");

	if (splitedA.length === 0 || splitedB.length === 0) {
		return splitedA.length - splitedB.length;
	}
	const yearA = parseInt(splitedA[0]);
	const yearB = parseInt(splitedB[0]);
	if (yearA - yearB !== 0) {
		return yearA - yearB;
	}

	if (splitedA.length === 1 || splitedB.length === 1) {
		return splitedA.length - splitedB.length;
	}
	const releaseA = parseInt(splitedA[1]);
	const releaseB = parseInt(splitedB[1]);
	if (releaseA - releaseB !== 0) {
		return releaseA - releaseB;
	}

	if (splitedA.length === 2 || splitedB.length === 2) {
		return splitedA.length - splitedB.length;
	}
	if (splitedA[2] > splitedB[2]) {
		return 1;
	} else if (splitedA[2] < splitedB[2]) {
		return -1;
	} else {
		return 0;
	}
}


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
		});
	} catch (err) {
		console.error('Failed to run tests: ' + err);
		process.exit(1);
	}
}

main();
