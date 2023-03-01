import * as path from 'path';
import glob from 'glob';

export function innerRun(regexToTestFiles: string): Promise<void> {
	// Create the mocha test
	const mocha = new Mocha({
		ui: 'tdd',
		color: true
	});

	const testsRoot = __dirname;

	return new Promise((c, e) => {
		glob(regexToTestFiles, { cwd: testsRoot }).then((files)=>{
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

