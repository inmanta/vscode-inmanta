import * as fs from 'fs-extra';
import { exec } from 'child_process';
import { coerce, SemVer } from 'semver';

/**
 * Read a lloging file waiting for a message annoucing the end of the compilation
 * 
 * @param logPath The path to the logging file
 * @param timeout A timeout (in ms) before the end of which the compilation should be done
 * 
 * @returns whether or not the compilation suceeded
 */
export function waitForCompile(logPath: string, timeout: number): Promise<boolean> {
	const start = Date.now();
	return new Promise<boolean>((resolve, reject) => {
		const readLogInterval = setInterval(() => {
			if (Date.now() - start > timeout) {
				reject(new Error(`Timeout of ${timeout}ms reached`));
			} else {
				fs.ensureFileSync(logPath);
				fs.readFile(logPath, 'utf-8', (err, data) => {
					if (err) {
						console.log(`Got an error while waiting for compile: ${err}`);
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

/**
 * Query the version of inmanta installed in the provided python environment.
 * @param pythonPath the path to the python binary in the environment in which inmanta is installed
 * 
 * @returns a Promise resolving a string, the verison of inmanta found.
 */
export async function getInmantaVersion(pythonPath: string): Promise<SemVer> {
	return new Promise<SemVer>((resolve, reject) => {
		exec(`${pythonPath} -m pip list --format json`, (err, stdout, stderr) => {
			if (err) {
				reject(err);
			} else {
				const packageList = JSON.parse(stdout);
				packageList.forEach(element => {
					if (element.hasOwnProperty("name") && element["name"] === "inmanta" && element.hasOwnProperty("version")) {
						resolve(coerce(element["version"]));
					}
				});
				reject(new Error("Could not find inmanta in provided python environment."));
			}
		});
	});
}