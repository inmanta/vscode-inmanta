import * as path from 'path';
import Mocha from 'mocha';
import { glob } from 'glob';


/**
 * Testing Framework UI Configuration:
 * 
 * ui: 'tdd' specifies the Test-Driven Development style interface for writing tests.
 * This means tests are written using:
 * - suite() : to group related tests
 * - test()  : to define individual test cases
 * - setup() : to run before each test suite
 * - teardown() : to run after each test suite
 * 
 * Example:
 * suite('Extension Test Suite', () => {
 *     test('Sample test', () => {
 *         // test code here
 *     });
 *     
 *     setup(() => {
 *         // setup code here
 *     });
 *     
 *     teardown(() => {
 *         // cleanup code here
 *     });
 * });
 * 
 * This is different from BDD (Behavior-Driven Development) style which uses:
 * describe(), it(), beforeEach(), afterEach()
 */

export function innerRun(regexToTestFiles: string): Promise<void> {
	// Create the mocha test
	const mocha = new Mocha({
		ui: 'tdd',
		color: true,
		timeout: 30000
	});

	const testsRoot = __dirname;

	return new Promise((c, e) => {
		glob(regexToTestFiles, { cwd: testsRoot }).then((files) => {
			files.forEach(f => mocha.addFile(path.resolve(testsRoot, f)));
			try {
				// Run the mocha test
				mocha.run(failures => {
					if (failures > 0) {
						e(new Error(`${failures} tests failed.`));
					} else {
						c();
					}
				});
			} catch (err) {
				console.error(err);
				e(err);
			}
		});
	});
}

