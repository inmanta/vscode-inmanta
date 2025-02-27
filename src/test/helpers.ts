import * as fs from 'fs-extra';

/**
 * Read a loging file waiting for a message announcing the end of the compilation
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
				clearInterval(readLogInterval);
				reject(new Error(`Timeout of ${timeout}ms reached`));
			} else {
				fs.ensureFileSync(logPath);
				fs.readFile(logPath, 'utf-8', (err, data) => {
					if (err) {
						clearInterval(readLogInterval);
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
 * Assert with timeout
 * @param assertion Function containing the assertion
 * @param timeoutMs Timeout in milliseconds
 * @param message Error message if timeout is reached
 */
export async function assertWithTimeout(assertion: () => Promise<void> | void, timeoutMs: number, message: string): Promise<void> {
    return new Promise(async (resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(`Timeout: ${message}`));
        }, timeoutMs);

        try {
            await assertion();
            clearTimeout(timeout);
            resolve();
        } catch (error) {
            clearTimeout(timeout);
            reject(error);
        }
    });
}