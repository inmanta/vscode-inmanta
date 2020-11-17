import * as path from 'path';
import * as Mocha from 'mocha';
import * as glob from 'glob';

export function innerRun(regexToTestFiles: string): Promise<void> {
	// Create the mocha test
	const mocha = new Mocha({
		ui: 'tdd',
		color: true
	});

	const testsRoot = __dirname;
	console.log(testsRoot);

	return new Promise((c, e) => {
		glob(regexToTestFiles, { cwd: testsRoot }, (err, files) => {
			console.log(files);
			if (err) {
				return e(err);
			}

			// Add files to the test suite
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
