'use strict';

import { workspace, ExtensionContext, extensions } from 'vscode';
import { PYTHONEXTENSIONID } from './python_extension';
import { Mutex } from 'async-mutex';
import { log } from './utils';
import { LanguageServer } from './language_server';
import { registerExportCommand, registerInstallLangueServerCommand } from './commands';

const mutex = new Mutex();
let languageserver;

export async function activate(context: ExtensionContext) {
	//use Python extension
	const pythonExtension = extensions.getExtension(PYTHONEXTENSIONID);
	if (pythonExtension === undefined) {
		throw Error("Python extension not found");
	}
	log("Activate Python extension");
	await pythonExtension.activate();

	languageserver = new LanguageServer(context, pythonExtension);

	const enable: boolean = workspace.getConfiguration('inmanta').ls.enabled;
	if (enable) {
		await languageserver.startOrRestartLS(true);
	}

	context.subscriptions.push(workspace.onDidChangeConfiguration(async e => {
		if (e.affectsConfiguration('inmanta')) {
			await languageserver.startOrRestartLS();
		}
	}));

	registerExportCommand(context, languageserver.pythonExtentionApi.pythonPath);
	registerInstallLangueServerCommand(context, languageserver)
}





export async function deactivate(){
	await mutex.runExclusive(async () => {
		return languageserver.stopServerAndClient();
	});
}
