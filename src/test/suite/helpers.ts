import * as fs from 'fs-extra';
import { exec } from 'child_process';


/**
 * 
 * @param logPath 
 * @param timeout 
 */
export function waitForCompile(logPath: string, timeout: number): Promise<boolean> {
	const start = Date.now();
	return new Promise<boolean>((resolve, reject) => {
		const readLogInterval = setInterval(() => {
			if (Date.now() - start > timeout) {
				reject(new Error("Timeout reached"));
			} else {
				fs.ensureFileSync(logPath);
				fs.readFile(logPath, 'utf-8', (err, data) => {
					if (err) {
						console.log(err);
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
 * 
 * @param pythonPath 
 */
export async function getInstalledPackages(pythonPath: string): Promise<any> {
	return new Promise<string>((resolve, reject) => {
		exec(`${pythonPath} -m pip list --format json`, (err, stdout, stderr) => {
			if (err) {
				reject(err);
			} else {
				resolve(JSON.parse(stdout));
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
export function compareVersions(a: string, b: string): number {
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