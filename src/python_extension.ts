'use strict';
import { exec } from 'child_process';
import { StatusBarAlignment, ThemeColor, window, workspace, TextDocument, WorkspaceFolder} from 'vscode';
import { IExtensionApi, Resource } from './types';
import { fileOrDirectoryExists, log } from './utils';

export const PYTHONEXTENSIONID = "ms-python.python";

export class PythonExtension {
	executionDetails: {execCommand: string[] | undefined;};
	callBacksOnchange: Array<() => void> = [];
	inmantaEnvSelector;

	/**
	 * Creates an instance of PythonExtension.
	 * @param {IExtensionApi} pythonApi The Python extension API.
	 * @param {Function} onChangeCallback The callback function to be called when the active interpreter is changed.
	 */
	constructor(pythonApi : IExtensionApi) {
		log("Instantiating new python extension");
		// log(`  resource: ${JSON.stringify(resource)}`);
		// log(`  resource: ${JSON.stringify(resource.index)}`);
		// log(`  resourcename: ${JSON.stringify(resource.name)}`);
		// log(`  resourceuri: ${JSON.stringify(resource.uri["path"])}`);

		// this.executionDetails = pythonApi.settings.getExecutionDetails(resource.uri); //workspace.workspaceFolders?.[0].uri);
		this.executionDetails = pythonApi.settings.getExecutionDetails(workspace.workspaceFolders?.[0].uri);
		log(`  execdeets ${this.executionDetails}`);
		this.onChange(pythonApi);
	}


	/**
	 * Gets the path to the Python interpreter being used by the extension.
	 * @returns {string} A string representing the path to the Python interpreter.
	 */
	get pythonPath(): string {
		return this.executionDetails.execCommand[0];
	}

	get virtualEnvName(): string | null {
		// Match the virtual environment name using a regular expression
		const match = this.pythonPath.match(/.*\/(.*?)\/bin\/python$/);

		// If a match is found, return the first capture group (the virtual environment name)
		if (match && match.length > 1) {
			return match[1];
		}
		// If no match is found, return the pythonpath
		return this.pythonPath;
	}


	async updatePythonVersion(): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			exec(`${this.pythonPath} --version`, (err, stdout, stderr) => {
				if (err || stderr) {
					reject(err || stderr);
				}
				const versionMatch = stdout.match(/Python\s+(\d+\.\d+\.\d+)/);
				if (versionMatch) {
					const version = versionMatch[1];
					console.log(`Python version: ${version}`);
					resolve(version);
				} else {
					reject(new Error('Failed to get Python version.'));
				}
			});
		});
	}

	async updateInmantaEnvVisibility() {
		let version ="";
		try{
			version = await this.updatePythonVersion();
		} catch (error){
			console.error(`Failed to get Python version:` + error);
		}
		let text = "$(alert) Select Interpreter";
		if (!this.pythonPath || !fileOrDirectoryExists(this.pythonPath)) {
			this.inmantaEnvSelector.backgroundColor = new ThemeColor('statusBarItem.warningBackground');
		} else {
			this.inmantaEnvSelector.backgroundColor = undefined;
			text = `${version} ('${this.virtualEnvName}')`;
		}
		const editor = window.activeTextEditor;
		this.inmantaEnvSelector.text = text;
		if (editor && ['inmanta','log','pip-requirements','properties'].includes(editor.document.languageId)) {
			this.inmantaEnvSelector.show();
		} else {
			this.inmantaEnvSelector.hide();
		}
	}


	addEnvSelector():void {
		log("add virtual env selector");
		// Add the EnvSelectorWindow
		this.inmantaEnvSelector = window.createStatusBarItem(StatusBarAlignment.Right);
		this.inmantaEnvSelector.command = "python.setInterpreter";
		this.inmantaEnvSelector.tooltip = "Select a virtual environment";
		// Update the button visibility when the extension is activated
		this.updateInmantaEnvVisibility();
		// Update the button visibility when the active editor changes
		window.onDidChangeActiveTextEditor(()=>this.updateInmantaEnvVisibility());
		this.registerCallbackOnChange(()=>this.updateInmantaEnvVisibility());

	}


	/**
	 * register a function that will be called when the "onChange" function is called
	 * @param {() => void} onChangeCallback A function
	 */
	registerCallbackOnChange(onChangeCallback: () => void) {
		this.callBacksOnchange.push(onChangeCallback);
	}

	/**
	 * Registers a listener for changes to the active interpreter and calls the callBacksOnchange functions when the interpreter changes.
	 * @param {IExtensionApi} pythonApi The Python extension API.
	 */
	private onChange(pythonApi : IExtensionApi) {
		pythonApi.settings.onDidChangeExecutionDetails(
			(resource: Resource) => {
				log(`EXECUTION DEETS CHANGED ${resource}`);

				let newExecutionDetails = pythonApi.settings.getExecutionDetails(resource);
				if(this.executionDetails.execCommand[0] !== newExecutionDetails.execCommand[0]){
					this.executionDetails = newExecutionDetails;
					for (const callback of this.callBacksOnchange) {
						callback();
					}
				}
			}
		);
	}
  }
