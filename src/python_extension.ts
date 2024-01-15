'use strict';
import { exec } from 'child_process';
import { StatusBarAlignment, ThemeColor, window, workspace, TextDocument, WorkspaceFolder, StatusBarItem} from 'vscode';
import { IExtensionApi, Resource } from './types';
import { fileOrDirectoryExists, log, getOuterMostWorkspaceFolder, logMap} from './utils';
import { getLanguageMap, getLastActiveFolder} from './extension';
import * as fs from "fs";


export const PYTHONEXTENSIONID = "ms-python.python";

export class PythonExtension {
	executionDetails: {execCommand: string[] | undefined;};
	callBacksOnchange: Array<(newPath?, outermost?) => void> = [];
	inmantaEnvSelector: StatusBarItem;
	pythonApi : IExtensionApi;
	lastOpenedFolder: WorkspaceFolder;
	/**
	 * Creates an instance of PythonExtension.
	 * @param {IExtensionApi} pythonApi The Python extension API.
	 * @param {Function} onChangeCallback The callback function to be called when the active interpreter is changed.
	 */
	constructor(pythonApi : IExtensionApi) {
		this.executionDetails = pythonApi.settings.getExecutionDetails(workspace.workspaceFolders?.[0].uri);
		this.pythonApi = pythonApi;
		this.onChange(pythonApi);

	}

	/**
	 * Gets the path to the Python interpreter being used by the extension.
	 * @returns {string} A string representing the path to the Python interpreter.
	 */
	get pythonPath(): string {
		return PythonExtension.getPathPythonBinary(this.executionDetails.execCommand[0]);
	}

	get virtualEnvName(): string | null {
		return this.pythonPathToEnvName(this.pythonPath);
	}


	/**
	 * Due to bug https://github.com/microsoft/vscode-python/issues/22617, the `this.pythonApi.settings.getExecutionDetails()` method
	 * might return the path to the root of the venv instead of the path to the python binary in that venv. This method exists to work
	 * around that issue.
	 */
	private static getPathPythonBinary(execCommand: string): string {
		if(PythonExtension.isFile(execCommand)){
			return execCommand;
		}
		for(const pythonSuffix of ["python3", "python"]){
			const execCommandWithSuffix = execCommand + "/bin/" + pythonSuffix;
			if(PythonExtension.isFile(execCommandWithSuffix)){
				return execCommandWithSuffix;
			}
		}
		throw new Error(`Failed to find python binary ${execCommand}`);
	}


	/**
	 * @returns {boolean} True iff the given path references a file (or symbolic link to file).
	 */
	private static isFile(path: string): boolean {
		try{
			const stat = fs.statSync(path);
			return stat.isFile();
		} catch(err){
			return false;
		}
	}

	pythonPathToEnvName(path: string) : string {
		/**
		 *  Match the virtual environment name using a regular expression to transform 
		 *  it to an Environment name if a match is found. If no match is found, return the pythonpath
		 * @returns {string} A string representing the path to the Python interpreter.
		 */

		const match = path.match(/.*\/(.*?)\/bin\/python$/);
		
		if (match && match.length > 1) {
			return match[1];
		}

		return path;
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

	async updateInmantaEnvVisibility(documentURI?) {
		let venvName = this.virtualEnvName;
		let folderName = "";
		let lastActiveFolder = getLastActiveFolder();
		if (lastActiveFolder) {
			folderName = lastActiveFolder.name;
		}
		if (documentURI) {
			try{
				let folder = workspace.getWorkspaceFolder(documentURI);
				if (folder) {
					folderName = folder.name;
					venvName = this.pythonPathToEnvName(getLanguageMap().get(folder.uri.toString()).pythonPath);
				}
			}

			catch (error){
				console.error(`Failed to get Python version:` + error);
			}
			
		}

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
			text = `${version} ('${venvName}') ${folderName}`;
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
		// Add the EnvSelectorWindow
		this.inmantaEnvSelector = window.createStatusBarItem(StatusBarAlignment.Right);
		this.inmantaEnvSelector.command = "python.setInterpreter";
		this.inmantaEnvSelector.tooltip = "Select a virtual environment";
		// Update the button visibility when the extension is activated
		this.updateInmantaEnvVisibility();
		this.registerCallbackOnChange(()=>this.updateInmantaEnvVisibility());

	}


	/**
	 * register a function that will be called when the "onChange" function is called
	 * @param {(newPath?) => void} onChangeCallback A function
	 */
	registerCallbackOnChange(onChangeCallback: (newPath?, outermost?) => void) {
		this.callBacksOnchange.push(onChangeCallback);
	}

	getPathForResource(resource) {
		try{
			const execDetails = this.pythonApi.settings.getExecutionDetails(resource);
			return PythonExtension.getPathPythonBinary(execDetails.execCommand[0]);
		} catch (error){
			console.error(`Failed to getPathForResource   :` + error.name + error.message);
		}
	}

	/**
	 * Registers a listener for changes to the active interpreter and calls the callBacksOnchange functions when the interpreter changes.
	 * @param {IExtensionApi} pythonApi The Python extension API.
	 */
	private onChange(pythonApi : IExtensionApi) {
		pythonApi.settings.onDidChangeExecutionDetails(
			(resource: Resource) => {
				let newExecutionDetails = pythonApi.settings.getExecutionDetails(resource);
				let folder = workspace.getWorkspaceFolder(resource);
				let outermost = getOuterMostWorkspaceFolder(folder).uri;

				if(this.executionDetails.execCommand[0] !== newExecutionDetails.execCommand[0]){
					this.executionDetails = newExecutionDetails;
					const newPathPythonBinary = PythonExtension.getPathPythonBinary(newExecutionDetails.execCommand[0]);
					for (const callback of this.callBacksOnchange) {
						callback(newPathPythonBinary, outermost);
					}
				}
			}
		);
	}
  }
