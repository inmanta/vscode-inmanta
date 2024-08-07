'use strict';

import { workspace, ExtensionContext, extensions, window, commands, WorkspaceFolder, TextDocument, TextEditor } from 'vscode';
import { PythonExtension, PYTHONEXTENSIONID } from './python_extension';
import { log, getOuterMostWorkspaceFolder, logMap } from './utils';
import { LanguageServer, LsErrorHandler } from './language_server';
import { InmantaCommands } from './commands';
import { addSetupAssistantButton } from './walkthrough_button';

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


let pythonExtensionInstance ;

export async function activate(context: ExtensionContext) {
	const pythonExtension = extensions.getExtension(PYTHONEXTENSIONID);

	// Get and activate the Python extension instance
	if (pythonExtension === undefined) {
		throw Error("Python extension not found");
	}

	log("Activate Python extension");
	await pythonExtension.activate();
	// Start a new instance of the python extension
	pythonExtensionInstance = new PythonExtension(pythonExtension.exports);
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

		if (folder === undefined ){
			// This happens for example when looking at a .py file living in a venv outside of the current workspace, in which case we must hide our button
			pythonExtensionInstance.updateInmantaEnvVisibility();
			return;
		}

		folder = getOuterMostWorkspaceFolder(folder);

		// Update the button visibility when the active editor changes
		pythonExtensionInstance.updateInmantaEnvVisibility(folder.uri);

		if (event.document.languageId !== 'inmanta' || (event.document.uri.scheme !== 'file')) {
			return;
		}
		if (folder === lastActiveFolder) {
			return;
		}
		lastActiveFolder = folder;
		const languageServer = languageServers.get(folder.uri.toString());

		inmantaCommands.registerCommands(languageServer);
	}

	async function didOpenTextDocument(document: TextDocument): Promise<void> {
		pythonExtensionInstance.updateInmantaEnvVisibility(document.uri);
		// We are only interested in .cf files

		if (document.languageId !== 'inmanta' || (document.uri.scheme !== 'file')) {
			return;
		}


		const uri = document.uri;

		let folder = workspace.getWorkspaceFolder(uri);
		// Files outside a folder can't be handled.
		if (!folder) {
			return;
		}
		// If we have nested workspace folders we only start a language server on the outer most workspace folder.
		folder = getOuterMostWorkspaceFolder(folder);
		lastActiveFolder = folder;
		const folderURI = folder.uri.toString();

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

			const newPath = pythonExtensionInstance.getPathForResource(folder.uri);

			const errorHandler = new LsErrorHandler(folder);

			const languageserver = new LanguageServer(context, newPath, folder, errorHandler);
			log("created LanguageServer");
			//register listener to restart the LS if the python interpreter changes.
			pythonExtensionInstance.registerCallbackOnChange(
				(updatedPath, outermost) => {
					languageserver.updatePythonPath(updatedPath, outermost).then(
						() => {
							pythonExtensionInstance.updateInmantaEnvVisibility(document.uri);
						}
					).then(
						() => {
							inmantaCommands.registerCommands(languageserver);
						}
					).catch(
						(_err) => {
							console.error(`Error updating python path to ${updatedPath}`);
					})
					;
				}
			);
			inmantaCommands.registerCommands(languageserver);


			// Start the language server if enabled in the workspace configuration
			const enable: boolean = workspace.getConfiguration('inmanta', folder).ls.enabled;
			if (enable) {
				await languageserver.startOrRestartLS(true);
			}

			log(`adding ${folder.uri.toString()} to languageServers`);


			languageServers.set(folder.uri.toString(), languageserver);
			logMap(languageServers, "languageServers:");

		}


	}

	workspace.onDidOpenTextDocument(didOpenTextDocument);
	workspace.textDocuments.forEach(didOpenTextDocument);
	window.onDidChangeActiveTextEditor((event: TextEditor) => changeActiveTextEditor(event));
	workspace.onDidChangeWorkspaceFolders((event) => {
		log("workspaces changed" + String(event));
		for (const folder of event.removed) {
			const ls = languageServers.get(folder.uri.toString());
			if (ls) {
				languageServers.delete(folder.uri.toString());
				ls.stopServerAndClient();
				ls.cleanOutputChannel();
			}
		}
	});

	// Subscribe to workspace configuration changes and restart the affected language server(s) if necessary
	context.subscriptions.push(workspace.onDidChangeConfiguration(async event => {
		log(`config changed ${JSON.stringify(event)}`);
		const promises: Thenable<void>[] = [];
		for (const ls of languageServers.values()) {
			if (event.affectsConfiguration('inmanta', ls.rootFolder)) {
				promises.push(ls.startOrRestartLS());
			}
		}
		await Promise.all(promises);
	}));

}

export async function deactivate(): Promise<void> {
	const promises: Thenable<void>[] = [];
	for (const ls of languageServers.values()) {
		promises.push(ls.stopServerAndClient());
	}
	await Promise.all(promises);
}


export function getLanguageMap(): Map<string, LanguageServer> {
	return languageServers;
}

export function getLastActiveFolder(): WorkspaceFolder {
	return lastActiveFolder;
}

