'use strict';

import { workspace } from 'vscode';
import { IExtensionApi, Resource } from './types';

export const PYTHONEXTENSIONID = "ms-python.python";

export class PythonExtension {
	executionDetails: {execCommand: string[] | undefined;};
	callBacksOnchange: Array<() => void> = [];

	/**
	 * Creates an instance of PythonExtension.
	 * @param {IExtensionApi} pythonApi The Python extension API.
	 * @param {Function} onChangeCallback The callback function to be called when the active interpreter is changed.
	 */
	constructor(pythonApi : IExtensionApi) {
		this.executionDetails = pythonApi.settings.getExecutionDetails(workspace.workspaceFolders?.[0].uri);
		this.onChange(pythonApi);
	}

	/**
	 * Gets the path to the Python interpreter being used by the extension.
	 * @returns {string} A string representing the path to the Python interpreter.
	 */
	get pythonPath(): string {
		return this.executionDetails.execCommand[0];
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
