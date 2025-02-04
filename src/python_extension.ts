'use strict';
import { exec } from 'child_process';
import { StatusBarAlignment, ThemeColor, window, workspace, WorkspaceFolder, StatusBarItem, Uri } from 'vscode';
import { IExtensionApi, Resource } from './types';
import { fileOrDirectoryExists, getOuterMostWorkspaceFolder } from './utils';
import { getLanguageMap, getLastActiveFolder } from './extension';
import * as fs from "fs";

export const PYTHONEXTENSIONID = "ms-python.python";

export class PythonExtension {
	executionDetails: { execCommand: string[] | undefined; };
	callBacksOnchange: Array<(newPath?: string, outermost?: Uri) => void> = [];
	inmantaEnvSelector: StatusBarItem;
	pythonApi: IExtensionApi;
	lastOpenedFolder: WorkspaceFolder;
	/**
	 * Creates an instance of PythonExtension.
	 * @param {IExtensionApi} pythonApi The Python extension API.
	 * @param {Function} onChangeCallback The callback function to be called when the active interpreter is changed.
	 */
	constructor(pythonApi: IExtensionApi) {
		this.executionDetails = pythonApi.settings.getExecutionDetails(workspace.workspaceFolders?.[0].uri);
		this.pythonApi = pythonApi;
		this.onChange(pythonApi);

	}

	/**
	 * Gets the path to the Python interpreter being used by the extension.
	 * @returns {string} A string representing the path to the Python interpreter.
	 */
	get pythonPath(): string {
		if (!this.executionDetails.execCommand || this.executionDetails.execCommand.length === 0) {
			throw new Error("Execution command is not defined.");
		}
		return PythonExtension.getPathPythonBinary(this.executionDetails.execCommand[0]);
	}

	get virtualEnvName(): string {
		return this.pythonPathToEnvName(this.pythonPath);
	}


	/**
	 * Due to bug https://github.com/microsoft/vscode-python/issues/22617, the `this.pythonApi.settings.getExecutionDetails()` method
	 * might return the path to the root of the venv instead of the path to the python binary in that venv. This method exists to work
	 * around that issue.
	 */
	private static getPathPythonBinary(execCommand: string): string {
		if (PythonExtension.isFile(execCommand)) {
			return execCommand;
		}
		for (const pythonSuffix of ["python3", "python"]) {
			const execCommandWithSuffix = execCommand + "/bin/" + pythonSuffix;
			if (PythonExtension.isFile(execCommandWithSuffix)) {
				return execCommandWithSuffix;
			}
		}
		throw new Error(`Failed to find python binary ${execCommand}`);
	}


	/**
	 * @returns {boolean} True iff the given path references a file (or symbolic link to file).
	 */
	private static isFile(path: string): boolean {
		try {
			const stat = fs.statSync(path);
			return stat.isFile();
		} catch (_err) {
			return false;
		}
	}

	pythonPathToEnvName(path: string): string {
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
				if (!this.pythonPath) {
					reject(new Error('Python path is not defined.'));
				}

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

	/**
	 * Updates the visibility and text of the inmantaEnvSelector based on the current Python environment and active editor.
	 * @param {Uri} [documentURI] - The URI of the document to check the workspace folder for.
	 */
	async updateInmantaEnvVisibility(documentURI?: Uri): Promise<void> {
		const venvName = this.getVenvNameFromDocumentURI(documentURI);
		const folderName = this.getFolderName(documentURI);

		const version = await this.getPythonVersion();
		const text = this.getSelectorText(version, venvName, folderName);

		this.updateEnvSelector(text);
	}

	/**
	 * Retrieves the folder name based on the document URI or the last active folder.
	 * @param {Uri} [documentURI] - The URI of the document to check the workspace folder for.
	 * @returns {string} - The folder name.
	 */
	private getFolderName(documentURI?: Uri): string {
		const lastActiveFolder = getLastActiveFolder();
		if (lastActiveFolder) {
			return lastActiveFolder.name;
		}

		if (documentURI) {
			const folder = workspace.getWorkspaceFolder(documentURI);
			if (folder) {
				return folder.name;
			}
		}

		return "";
	}

	/**
	 * Retrieves the virtual environment name from the document URI.
	 * If the document URI is not provided, the virtual environment name is retrieved from the last active folder.
	 * @param {Uri} documentURI - The URI of the document to check the workspace folder for.
	 * @returns {string} - The virtual environment name for the provided URI, or the last active folder.
	 */
	private getVenvNameFromDocumentURI(documentURI?: Uri): string {
		try {
			const folder = workspace.getWorkspaceFolder(documentURI);
			if (folder) {
				return this.pythonPathToEnvName(getLanguageMap().get(folder.uri.toString()).pythonPath);
			}
		} catch (error) {
			console.error(`Failed to get virtual environment name: ${error}`);
		}

		return this.virtualEnvName;
	}

	/**
	 * Retrieves the Python version.
	 * @returns {Promise<string>} - The Python version.
	 */
	private async getPythonVersion(): Promise<string> {
		try {
			return await this.updatePythonVersion();
		} catch (error) {
			console.error(`Failed to get Python version: ${error}`);
			return "";
		}
	}

	/**
	 * Constructs the text for the inmantaEnvSelector.
	 * @param {string} version - The Python version.
	 * @param {string} venvName - The virtual environment name.
	 * @param {string} folderName - The folder name.
	 * @returns {string} - The constructed text.
	 */
	private getSelectorText(version: string, venvName: string, folderName: string): string {
		if (!this.pythonPath || !fileOrDirectoryExists(this.pythonPath)) {
			this.inmantaEnvSelector.backgroundColor = new ThemeColor('statusBarItem.warningBackground');
			return "$(alert) Select Interpreter";
		} else {
			this.inmantaEnvSelector.backgroundColor = undefined;
			return `${version} ('${venvName}') ${folderName}`;
		}
	}

	/**
	 * Updates the inmantaEnvSelector with the provided text.
	 * @param {string} text - The text to set for the inmantaEnvSelector.
	 */
	private updateEnvSelector(text: string): void {
		const editor = window.activeTextEditor;
		this.inmantaEnvSelector.text = text;
		if (editor && ['inmanta', 'log', 'pip-requirements', 'properties'].includes(editor.document.languageId)) {
			this.inmantaEnvSelector.show();
		} else {
			this.inmantaEnvSelector.hide();
		}
	}


	addEnvSelector(): void {
		// Add the EnvSelectorWindow
		this.inmantaEnvSelector = window.createStatusBarItem(StatusBarAlignment.Right);
		this.inmantaEnvSelector.command = "python.setInterpreter";
		this.inmantaEnvSelector.tooltip = "Select a virtual environment";
		// Update the button visibility when the extension is activated
		this.updateInmantaEnvVisibility();
		this.registerCallbackOnChange(() => this.updateInmantaEnvVisibility());

	}


	/**
	 * register a function that will be called when the "onChange" function is called
	 * @param {(newPath?) => void} onChangeCallback A function
	 */
	registerCallbackOnChange(onChangeCallback: (newPath?, outermost?) => void) {
		this.callBacksOnchange.push(onChangeCallback);
	}

	getPathForResource(resource) {
		try {
			const execDetails = this.pythonApi.settings.getExecutionDetails(resource);
			return PythonExtension.getPathPythonBinary(execDetails.execCommand[0]);
		} catch (error) {
			console.error(`Failed to getPathForResource   :` + error.name + error.message);
		}
	}

	/**
	 * Registers a listener for changes to the active interpreter and calls the callBacksOnchange functions when the interpreter changes.
	 * @param {IExtensionApi} pythonApi The Python extension API.
	 */
	private onChange(pythonApi: IExtensionApi) {
		pythonApi.settings.onDidChangeExecutionDetails(
			(resource: Resource) => {
				const newExecutionDetails = pythonApi.settings.getExecutionDetails(resource);
				const folder = workspace.getWorkspaceFolder(resource);
				const outermost = getOuterMostWorkspaceFolder(folder).uri;

				if (this.executionDetails.execCommand[0] !== newExecutionDetails.execCommand[0]) {
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
