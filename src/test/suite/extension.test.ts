import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
// import * as myExtension from '../../extension';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});
});

suite('Model compile tests', () => {

	const modelBase: string = "" +
		"entity Person:\n" +
		"    string name\n" +
		"    int age\n" +
		"end\n\n" +
		"Person.friends [0:] -- Person\n\n" +
		"index Person(name)\n\n" +
		"implement Person using std::none\n\n"

	test('Valid model test', () => {
		const model: string = modelBase +
			"john = Person(name='John', age=20)\n" +
			"mike = Person(name='Mike', age=21)\n" +
			"jane = Person(name='Jane', age=19)\n" +
			"lucy = Person(name='Lucy', age=23)\n\n" +
			"john.friends += mike\n" +
			"john.friends += jane\n\n" +
			"mike.friends += jane\n" +
			"mike.friends += john\n\n" +
			"jane.friends += john\n" +
			"jane.friends += mike\n"
	});

	test('Invalid model test', () => {
		const model: string = modelBase +
			"john = Person(name='John', age=20)\n" +
			"mike = Person(name='Mike', age=21)\n" +
			"jane = Person(name='Jane', age=19)\n" +
			"lucy = Person(name='John', age=23)\n\n" +
			"john.friends += mike\n" +
			"john.friends += jane\n\n" +
			"mike.friends += jane\n" +
			"mike.friends += john\n\n" +
			"jane.friends += john\n" +
			"jane.friends += mike\n"
	});
});

suite('CTRL + Click tests', () => {

});

suite('Venv installation tests', () => {

});