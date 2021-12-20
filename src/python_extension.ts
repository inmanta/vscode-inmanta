'use strict';

import { workspace } from 'vscode';
import { log } from './extension';
import { IExtensionApi, Resource } from './types';

export const PYTHONEXTENSIONID = "ms-python.python";

export class PythonExtension {
	executionDetails: {execCommand: string[] | undefined;};
	constructor(pythonApi : IExtensionApi, private onChangeCallback: Function) {
		this.executionDetails = pythonApi.settings.getExecutionDetails(workspace.workspaceFolders?.[0].uri);
		this.onChange(pythonApi);
	}

	get pythonPath(): string {
		return this.executionDetails.execCommand[0];
	}

	private onChange(pythonApi : IExtensionApi) {
		pythonApi.settings.onDidChangeExecutionDetails(
			(resource: Resource) => {
				log(`Active interpreter changed for: ${resource}`);
				log(`Execution details: ${JSON.stringify(this.executionDetails)}`);
				this.executionDetails = pythonApi.settings.getExecutionDetails(resource);
				this.onChangeCallback();
			}
		);
	}


  }

