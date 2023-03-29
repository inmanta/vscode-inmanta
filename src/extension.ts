'use strict';

import { workspace, ExtensionContext, extensions, window, commands, WorkspaceFolder, Uri, TextDocument, TextEditor } from 'vscode';
import { PythonExtension, PYTHONEXTENSIONID } from './python_extension';
import { log } from './utils';
import { LanguageServer, LsErrorHandler } from './language_server';
import { commandActivateLSHandler, createHandlerExportCommand, createProjectInstallHandler, InmantaCommands } from './commands';
import { addSetupAssistantButton } from './walkthrough_button';
import * as cp from 'child_process';

let inmantaCommands;
let lastActiveFolder: WorkspaceFolder = undefined;

/*
	Keep track of active language servers per independant top-most folder in the workspace.
	We lazily spin up a new language server any time a .cf file living inside a folder is opened for the first time.
	Once the language server is up, it is added to the languageServers map with the uri of the top-most folder it is
	responsible for as a key. This allows the servers to be properly stopped if/when the folder is removed from the
	workspace
*/

export var languageServers: Map<string, LanguageServer> = new Map();

export function logMap(map: Map<string, LanguageServer>) {
	for (let [key, value] of map) {
		console.log(key);
	}
}

/*
	The following functions sortedWorkspaceFolders and getOuterMostWorkspaceFolder are taken from the vs-code extension example at
	https://github.com/microsoft/vscode-extension-samples/blob/main/lsp-multi-server-sample/client/src/extension.ts
	under this license: https://github.com/microsoft/vscode-extension-samples/blob/main/LICENSE
*/

/*
Copyright (c) Microsoft Corporation

All rights reserved.

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation
files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy,
modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software
is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED *AS IS*, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS
BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

let _sortedWorkspaceFolders: string[] | undefined;
function sortedWorkspaceFolders(): string[] {
	if (_sortedWorkspaceFolders === void 0) {
		_sortedWorkspaceFolders = workspace.workspaceFolders ? workspace.workspaceFolders.map(folder => {
			let result = folder.uri.toString();
			if (result.charAt(result.length - 1) !== '/') {
				result = result + '/';
			}
			return result;
		}).sort(
			(a, b) => {
				return a.length - b.length;
			}
		) : [];
	}
	return _sortedWorkspaceFolders;
}

workspace.onDidChangeWorkspaceFolders(() => _sortedWorkspaceFolders = undefined);

export function getOuterMostWorkspaceFolder(folder: WorkspaceFolder): WorkspaceFolder {
	const sorted = sortedWorkspaceFolders();
	for (const element of sorted) {
		let uri = folder.uri.toString();
		if (uri.charAt(uri.length - 1) !== '/') {
			uri = uri + '/';
		}
		if (uri.startsWith(element)) {
			return workspace.getWorkspaceFolder(Uri.parse(element))!;
		}
	}
	return folder;
}

function registerCommands(languageServer: LanguageServer): void {
	// We have to register these commands each time a diffent language server is being activated or "focussed".
	// Activation happens the first time a .cf file from this language server's folders is opened and focus
	// happens when selecting a file from a different workspace folder


	log(`Registering inmanta commands for language server responsible for ${languageServer.rootFolder} using ${languageServer.pythonPath} environment.`);
	inmantaCommands.registerCommand(`inmanta.exportToServer`, createHandlerExportCommand(languageServer.pythonPath));
	inmantaCommands.registerCommand(`inmanta.activateLS`, commandActivateLSHandler(languageServer.rootFolder));
	inmantaCommands.registerCommand(`inmanta.projectInstall`, createProjectInstallHandler(languageServer.pythonPath));
	inmantaCommands.registerCommand(`inmanta.installLS`, () => { languageServer.installLanguageServer(); });

}

export async function activate(context: ExtensionContext) {
	// Get and activate the Python extension instance
	const pythonExtension = extensions.getExtension(PYTHONEXTENSIONID);
	if (pythonExtension === undefined) {
		throw Error("Python extension not found");
	}

	log("Activate Python extension");
	await pythonExtension.activate();

	// Start a new instance of the python extension
	let pythonExtensionInstance = new PythonExtension(pythonExtension.exports);
	//add the EnvSelector button
	pythonExtensionInstance.addEnvSelector();

	//adds the SetupAssistantButton Button
	addSetupAssistantButton();

	// Create a new instance of InmantaCommands to register commands
	inmantaCommands = new InmantaCommands(context);

	inmantaCommands.registerCommand(`inmanta.openWalkthrough`, () => {
		commands.executeCommand(`workbench.action.openWalkthrough`, `Inmanta.inmanta#inmanta.walkthrough`, false);
	});

	function changeActiveTextEditor(event: TextEditor) {
		// Any time we select a .cf file from another folder in the workspace we have to override the already registered commands
		// so that they operate on the desired folders, with the correct virtual environment.
		if (event === undefined) {
			return;
		}
		const uri = event.document.uri;
		let folder = workspace.getWorkspaceFolder(uri);
		folder = getOuterMostWorkspaceFolder(folder);

		if (folder === lastActiveFolder) {
			return;
		}
		lastActiveFolder = folder;
		const languageServer = languageServers.get(folder.uri.toString());

		// Update the button visibility when the active editor changes
		pythonExtensionInstance.updateInmantaEnvVisibility(folder);
		registerCommands(languageServer);
	}

	async function didOpenTextDocument(document: TextDocument): Promise<void> {

		const uri = document.uri;

		let folder = workspace.getWorkspaceFolder(uri);
		// Files outside a folder can't be handled.
		if (!folder) {
			return;
		}
		// If we have nested workspace folders we only start a language server on the outer most workspace folder.
		folder = getOuterMostWorkspaceFolder(folder);
		lastActiveFolder = folder;
		let folderURI = folder.uri.toString();

		// We are only interested in .cf files
		if (document.languageId !== 'inmanta' || (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled')) {
			return;
		}


		if (!languageServers.has(folderURI)) {
			/*
				The document that was just opened is not living inside a folder that has a language server responsible for it.
				We need to start a new language server for this folder. For a seamless user experience, we mimick the behaviour
				of the pylance extension:
				
				- Case 1: a venv for this folder has already been selected in the past and persisted by vs code in the persistent
				storage ==> we simply use this venv and start a new language server. see https://github.com/microsoft/vscode-python/wiki/Setting-descriptions#pythondefaultinterpreterpath)

				- Case 2: this is a fresh folder with no pre-selected venv
					* if a workspace-wide venv has been selected -> use this one
					* use the default environment used by the python extension (https://code.visualstudio.com/docs/python/environments#_where-the-extension-looks-for-environments)
				
			*/

			let newPath = pythonExtensionInstance.getPathForResource(folder.uri);


			// This check makes sure the active interpreter is part of a venv so we don't install anything in a global env.
			// Inspired by: https://stackoverflow.com/questions/1871549/determine-if-python-is-running-inside-virtualenv/42580137#42580137
			const script = "import sys\n" +
				"real_prefix = getattr(sys, 'real_prefix', None)\n" +
				"base_prefix = getattr(sys, 'base_prefix', sys.prefix)\n" +
				"running_in_virtualenv = (base_prefix or real_prefix) != sys.prefix\n" +
				"if not running_in_virtualenv:\n" +
				"  sys.exit(1)";

			let spawnResult = cp.spawnSync(newPath, ["-c", script]);
			const stdout = spawnResult.stdout.toString();
			if (spawnResult.status === 1) {
				const response = await window.showErrorMessage(`The active python interpreter is not part of a virtual environment.`, 'Select interpreter');
				if (response === 'Select interpreter') {
					await commands.executeCommand('python.setInterpreter');
				}
				else {
					return;
				}
			}

			let errorHandler = new LsErrorHandler(folder);
			let languageserver = new LanguageServer(context, newPath, folder, errorHandler);
			log("created LanguageServer");

			//register listener to restart the LS if the python interpreter changes.
			pythonExtensionInstance.registerCallbackOnChange((updatedPath, outermost) => {
				languageserver.updatePythonPath(updatedPath, outermost);
				pythonExtensionInstance.updateInmantaEnvVisibility(document);
			});


			registerCommands(languageserver);

			// Start the language server if enabled in the workspace configuration
			const enable: boolean = workspace.getConfiguration('inmanta', folder).ls.enabled;
			if (enable) {
				await languageserver.startOrRestartLS(true);
			}

			log(`adding ${folder.uri.toString()} to languageServers`);


			languageServers.set(folder.uri.toString(), languageserver);
			logMap(languageServers);
			pythonExtensionInstance.updateInmantaEnvVisibility(document);

		}


	}

	workspace.onDidOpenTextDocument(didOpenTextDocument);
	workspace.textDocuments.forEach(didOpenTextDocument);
	window.onDidChangeActiveTextEditor((event: TextEditor) => changeActiveTextEditor(event));
	workspace.onDidChangeWorkspaceFolders((event) => {
		log("workspaces changed" + String(event));
		log(`before `);
		logMap(languageServers);

		for (const folder of event.removed) {
			const ls = languageServers.get(folder.uri.toString());
			if (ls) {
				languageServers.delete(folder.uri.toString());
				ls.stopServerAndClient();
				ls.cleanOutputChannel();
			}
		}
		log(`after `);
		logMap(languageServers);

	});

	// Subscribe to workspace configuration changes and restart the affected language server(s) if necessary
	context.subscriptions.push(workspace.onDidChangeConfiguration(async event => {
		log("config changed" + String(event));
		const promises: Thenable<void>[] = [];
		for (const ls of languageServers.values()) {
			if (event.affectsConfiguration('inmanta', ls.rootFolder)) {
				await ls.startOrRestartLS();
			}
		}
	}));

}

export async function deactivate(): Promise<void> {
	const promises: Thenable<void>[] = [];
	for (const ls of languageServers.values()) {
		promises.push(ls.stopServerAndClient());
	}
	return Promise.all(promises).then(() => undefined);
}


export function getLanguageMap(): Map<string, LanguageServer> {
	return languageServers;
}

export function getLastActiveFolder(): WorkspaceFolder {
	return lastActiveFolder;
}
