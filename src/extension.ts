'use strict';

import { workspace, ExtensionContext, extensions, window, commands, Position, Range } from 'vscode';
import { PythonExtension, PYTHONEXTENSIONID } from './python_extension';
import { log } from './utils';
import { LanguageServer } from './language_server';
import { commandActivateLSHandler, createHandlerExportCommand, createProjectInstallHandler, InmantaCommands } from './commands';
import { ErrorHandler, Message, ErrorAction, CloseAction, ErrorHandlerResult, CloseHandlerResult } from 'vscode-languageclient';
import { addSetupAssistantButton } from './walkthrough_button';

let languageserver;
let pythonExtensionInstance;
let inmantaCommands;

export async function activate(context: ExtensionContext) {
	// Get and activate the Python extension instance
	const pythonExtension = extensions.getExtension(PYTHONEXTENSIONID);
	if (pythonExtension === undefined) {
		throw Error("Python extension not found");
	}
	log("Activate Python extension");
	await pythonExtension.activate();

	pythonExtensionInstance = new PythonExtension(pythonExtension.exports);
	//add the EnvSelector button
	pythonExtensionInstance.addEnvSelector();

	//adds the SetupAssistantButton Button
	addSetupAssistantButton();

	// Create a new instance of LanguageServer and an ErrorHandler
	log("create LanguageServer");
	const errorhandler: LsErrorHandler = new LsErrorHandler();
	languageserver = new LanguageServer(context, pythonExtensionInstance.pythonPath, errorhandler);
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
		languageserver.installLanguageServer(false);
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


	// Subscribe to workspace configuration changes and restart the language server if necessary
	context.subscriptions.push(workspace.onDidChangeConfiguration(async event => {
		if (event.affectsConfiguration('inmanta')) {
			await languageserver.startOrRestartLS();
		}
	}));


	// Start the language server if enabled in the workspace configuration
	const enable: boolean = workspace.getConfiguration('inmanta').ls.enabled;
	if (enable) {
		await languageserver.startOrRestartLS(true);
	}



}

export async function deactivate(){
	log("deactivate");
	return languageserver.stopServerAndClient();
}

/**
 * An implementation of the ErrorHandler interface for the language server client.
 */
export class LsErrorHandler implements ErrorHandler{
	async error(error: Error, message: Message | undefined, count: number | undefined): Promise<ErrorHandlerResult> {
		const languageServerDiagnose = await languageserver.canServerStart();
		if (languageServerDiagnose === languageServerDiagnose.unknown){
			window.showErrorMessage(error.name+": "+error.message);
		}
		if (languageServerDiagnose !== languageServerDiagnose.ok){
			await languageserver.proposeSolution(languageServerDiagnose);
		}
		return {action: ErrorAction.Shutdown};
	}

	closed(): CloseHandlerResult{
		return {action: CloseAction.DoNotRestart};
	}

}
