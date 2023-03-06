'use strict';

import { workspace, ExtensionContext, extensions, window } from 'vscode';
import { PYTHONEXTENSIONID } from './python_extension';
import { log } from './utils';
import { LanguageServer } from './language_server';
import { registerActivateLangueServer, registerExportCommand, registerInstallLangueServerCommand } from './commands';
import { ErrorHandler, Message, ErrorAction, CloseAction, ErrorHandlerResult, CloseHandlerResult } from 'vscode-languageclient';

let languageserver;

export async function activate(context: ExtensionContext) {
	// Get and activate the Python extension instance
	const pythonExtension = extensions.getExtension(PYTHONEXTENSIONID);
	if (pythonExtension === undefined) {
		throw Error("Python extension not found");
	}
	log("Activate Python extension");
	await pythonExtension.activate();

	// Create a new instance of LanguageServer and an ErrorHandler
	const errorhandler: LsErrorHandler = new LsErrorHandler();
	languageserver = new LanguageServer(context, pythonExtension, errorhandler);

	// Start the language server if enabled in the workspace configuration
	const enable: boolean = workspace.getConfiguration('inmanta').ls.enabled;
	if (enable) {
		await languageserver.startOrRestartLS(true);
	}

	// Register commands with VS Code
	registerExportCommand(context, languageserver.pythonExtentionApi.pythonPath);
	registerInstallLangueServerCommand(context, languageserver);
	registerActivateLangueServer(context);

	// Subscribe to workspace configuration changes and restart the language server if necessary
	context.subscriptions.push(workspace.onDidChangeConfiguration(async e => {
		if (e.affectsConfiguration('inmanta')) {
			await languageserver.startOrRestartLS();
		}
	}));
}

export async function deactivate(){
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
