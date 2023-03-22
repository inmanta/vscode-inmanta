'use strict';

import { workspace, ExtensionContext, extensions, window, commands , WorkspaceFolder, Uri, TextDocument} from 'vscode';
import { PythonExtension, PYTHONEXTENSIONID } from './python_extension';
import { log } from './utils';
import { LanguageServer, LsErrorHandler } from './language_server';
import { commandActivateLSHandler, createHandlerExportCommand, createProjectInstallHandler, InmantaCommands } from './commands';
import { ErrorHandler, Message, ErrorAction, CloseAction, ErrorHandlerResult, CloseHandlerResult } from 'vscode-languageclient';
import { addSetupAssistantButton } from './walkthrough_button';
import { env } from 'process';

let inmantaCommands;

// Keep track of active language servers per independant folder in the workspace
const languageServers: Map<string, LanguageServer> = new Map();

function logMap(map: Map<string, LanguageServer>) {
	for (let [key, value] of map) {
		console.log(key);
	}
}

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

function getOuterMostWorkspaceFolder(folder: WorkspaceFolder): WorkspaceFolder {
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

export async function activate(context: ExtensionContext) {
	// Get and activate the Python extension instance

	// Start a new instance of the python extension
	const pythonExtension = extensions.getExtension(PYTHONEXTENSIONID);
	if (pythonExtension === undefined) {
		throw Error("Python extension not found");
	}
	log("Activate Python extension");
	await pythonExtension.activate();

	let pythonExtensionInstance = new PythonExtension(pythonExtension.exports);
	//add the EnvSelector button
	pythonExtensionInstance.addEnvSelector();

	//adds the SetupAssistantButton Button
	addSetupAssistantButton();

	async function didOpenTextDocument(document: TextDocument): Promise<void> {


		// We are only interested in language mode text
		if (document.languageId !== 'inmanta' || (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled')) {
			return;
		}

		const uri = document.uri;

		let folder = workspace.getWorkspaceFolder(uri);
		// Files outside a folder can't be handled. This might depend on the language.
		// Single file languages like JSON might handle files outside the workspace folders.
		if (!folder) {
			return;
		}
		// If we have nested workspace folders we only start a server on the outer most workspace folder.
		folder = getOuterMostWorkspaceFolder(folder);

		
		let folderURI = folder.uri.toString();
		log(`OPened folder ${folderURI}`);
		if (!languageServers.has(folderURI)) {

		
			// let path = pythonExtension.exports.settings.getExecutionDetails(folder);

			// Create a new instance of LanguageServer and an ErrorHandler
			log("create new instance of LanguageServer");
			log(`becausese doc ${document.fileName.toString()} was opened`);
			let languageserver = new LanguageServer(context, pythonExtensionInstance.pythonPath, folder);
			// let errorHandler = new LsErrorHandler(languageserver);
			log("created LanguageServer");

			//register listener to restart the LS if the python interpreter changes.
			pythonExtensionInstance.registerCallbackOnChange(()=>{
				languageserver.updatePythonPath(pythonExtensionInstance.pythonPath);
			});


			// Create a new instance of InmantaCommands to register commands
			log("register commands");
			inmantaCommands = new InmantaCommands(context);
			inmantaCommands.registerCommand("inmanta.exportToServer", createHandlerExportCommand(pythonExtensionInstance.pythonPath));
			inmantaCommands.registerCommand("inmanta.activateLS", commandActivateLSHandler);
			inmantaCommands.registerCommand("inmanta.projectInstall", createProjectInstallHandler(pythonExtensionInstance.pythonPath));
			inmantaCommands.registerCommand("inmanta.installLS", () => {
				languageserver.installLanguageServer();
			});
			inmantaCommands.registerCommand("inmanta.openWalkthrough", () => {
				commands.executeCommand(`workbench.action.openWalkthrough`, `Inmanta.inmanta#inmanta.walkthrough`, false);
			});

			// register listener to recreate those commands with the right pythonPath if it changes
			log("register listeners");
			pythonExtensionInstance.registerCallbackOnChange(()=>{
				inmantaCommands.registerCommand("inmanta.exportToServer", createHandlerExportCommand(pythonExtensionInstance.pythonPath));
			});
			pythonExtensionInstance.registerCallbackOnChange(()=>{
				inmantaCommands.registerCommand("inmanta.projectInstall", createProjectInstallHandler(pythonExtensionInstance.pythonPath));
			});


			// const serverOptions = {
			// 	run: { module, transport: TransportKind.ipc },
			// 	debug: { module, transport: TransportKind.ipc }
			// };
			// const clientOptions: LanguageClientOptions = {
			// 	documentSelector: [
			// 		{ scheme: 'file', language: 'plaintext', pattern: `${folder.uri.fsPath}/**/*` }
			// 	],
			// 	diagnosticCollectionName: 'lsp-multi-server-example',
			// 	workspaceFolder: folder,
			// 	outputChannel: outputChannel
			// };

			// Start the language server if enabled in the workspace configuration
			const enable: boolean = workspace.getConfiguration('inmanta', folder).ls.enabled;
			if (enable) {
				await languageserver.startOrRestartLS(true);
			}

			log(`adding ${folder.uri.toString()} to languageServers`);


			languageServers.set(folder.uri.toString(), languageserver);
			logMap(languageServers);

		}
		else {
			log(`Folder already in the map`);
		}
	}

	
	workspace.onDidOpenTextDocument(didOpenTextDocument);
	// context.subscriptions.push(workspace.onDidOpenTextDocument(async event => didOpenTextDocument(event)));
	workspace.textDocuments.forEach(didOpenTextDocument);
	workspace.onDidChangeWorkspaceFolders((event) => {
		log("workspaces changed" + String(event));
		log(`before `);
		logMap(languageServers);

		for (const folder  of event.removed) {
			const ls = languageServers.get(folder.uri.toString());
			if (ls) {
				languageServers.delete(folder.uri.toString());
				ls.stopServerAndClient();
			}
		}
		log(`after `);
		logMap(languageServers);

	});



	// Subscribe to workspace configuration changes and restart the language server if necessary
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

// export async function deactivate(){
// 	log("deactivate");
// 	return languageserver.stopServerAndClient();
// }
export async function deactivate(): Promise<void> {
	const promises: Thenable<void>[] = [];
	for (const ls of languageServers.values()) {
		promises.push(ls.stopServerAndClient());
	}
	return Promise.all(promises).then(() => undefined);
}



