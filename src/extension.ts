'use strict';

import { workspace, ExtensionContext, extensions } from 'vscode';
import { PYTHONEXTENSIONID } from './python_extension';
import { Mutex } from 'async-mutex';
import { log } from './utils';
import { LanguageServer } from './language_server';
import { registerExportCommand, registerInstallLangueServerCommand } from './commands';

// Create a mutex to ensure exclusive access to the language server instance
const mutex = new Mutex();
let languageserver;

export async function activate(context: ExtensionContext) {
	// Get and activate the Python extension instance
	const pythonExtension = extensions.getExtension(PYTHONEXTENSIONID);
	if (pythonExtension === undefined) {
		throw Error("Python extension not found");
	}
	log("Activate Python extension");
	await pythonExtension.activate();

	// Create a new instance of the LanguageServer class
	languageserver = new LanguageServer(context, pythonExtension);

	// Start the language server if enabled in the workspace configuration
	const enable: boolean = workspace.getConfiguration('inmanta').ls.enabled;
	if (enable) {
		await languageserver.startOrRestartLS(true);
	}

	// Register commands with VS Code
	registerExportCommand(context, languageserver.pythonExtentionApi.pythonPath);
	registerInstallLangueServerCommand(context, languageserver);


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
