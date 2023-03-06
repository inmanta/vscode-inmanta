'use strict';

import { workspace } from 'vscode';
import { IExtensionApi, Resource } from './types';
import { log } from './utils';

export const PYTHONEXTENSIONID = "ms-python.python";

export class PythonExtension {
	executionDetails: {execCommand: string[] | undefined;};


	constructor(pythonApi : IExtensionApi, private onChangeCallback: Function) {
		/**
		 * Creates an instance of PythonExtension.
		 * @param {IExtensionApi} pythonApi The Python extension API.
		 * @param {Function} onChangeCallback The callback function to be called when the active interpreter is changed.
		 */
		this.executionDetails = pythonApi.settings.getExecutionDetails(workspace.workspaceFolders?.[0].uri);
		this.onChange(pythonApi);
	}

	get pythonPath(): string {
		/**
		 * Gets the path to the Python interpreter being used by the extension.
		 * @returns {string} A string representing the path to the Python interpreter.
		 */
		return this.executionDetails.execCommand[0];
	}

	private onChange(pythonApi : IExtensionApi) {
		/**
		 * Registers a listener for changes to the active interpreter and calls the onChangeCallback function when the interpreter changes.
		 * @param {IExtensionApi} pythonApi The Python extension API.
		 */
		pythonApi.settings.onDidChangeExecutionDetails(
			(resource: Resource) => {
				let newExecutionDetails = pythonApi.settings.getExecutionDetails(resource);
				if(this.executionDetails.execCommand[0] !== newExecutionDetails.execCommand[0]){
					log(`Active interpreter changed for: ${resource}`);
					log(`Execution details: ${JSON.stringify(this.executionDetails)}`);
					this.executionDetails = newExecutionDetails;
					this.onChangeCallback();
				}
			}
		);
	}
  }
