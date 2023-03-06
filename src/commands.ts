import * as path from 'path';
import * as cp from 'child_process';

import { ExtensionContext,window, OutputChannel, Uri, commands } from "vscode";
import { LanguageServer } from './language_server';

/**
 * Registers the 'exportToServer' command with VS Code. which exports the configuration to an Inmanta server.
 *
 * @param {ExtensionContext} context The extension context object provided by VS Code.
 * @param {string} pythonPath The path to the Python interpreter.
 */
export function registerExportCommand(context: ExtensionContext, pythonPath:string) {
	let exportToServerChannel: OutputChannel = null;
	const commandExportToServerId = 'inmanta.exportToServer';
	const commandHandlerExportToServer = (openedFileObj: object) => {
		const pathOpenedFile: string = String(openedFileObj);
		const cwdCommand: string = path.dirname(Uri.parse(pathOpenedFile).fsPath);
		const child = cp.spawn(pythonPath, ["-m", "inmanta.app", "-vv", "export"], {cwd: `${cwdCommand}`});

		if (exportToServerChannel === null) {
			exportToServerChannel = window.createOutputChannel("export to inmanta server");
		}

		// Clear the log and show the `export to inmanta server` log window to the user
		exportToServerChannel.clear();
		exportToServerChannel.show();

		child.stdout.on('data', (data) => {
			exportToServerChannel.appendLine(`stdout: ${data}`);
		});

		child.stderr.on('data', (data) => {
			exportToServerChannel.appendLine(`stderr: ${data}`);
		});

		child.on('close', (code) => {
			if (code === 0) {
				exportToServerChannel.appendLine("Export successful");
			} else {
				exportToServerChannel.appendLine(`Export failed (exitcode=${code})`);
			}
		});
	};
	context.subscriptions.push(commands.registerCommand(commandExportToServerId, commandHandlerExportToServer));
}

/**
 * Registers the 'installLS' command with VS Code, which installs the Inmanta language server.
 *
 * @param {ExtensionContext} context The extension context object provided by VS Code.
 * @param {LanguageServer} languageserver An instance of the LanguageServer class, which provides methods for installing and managing the language server.
 */
export function registerInstallLangueServerCommand(context: ExtensionContext, languageserver: LanguageServer){
	const commandInstallLSId = 'inmanta.installLS';
	const commandInstallLSHandler = () => {
	languageserver.installLanguageServer(false);
};
	context.subscriptions.push(commands.registerCommand(commandInstallLSId, commandInstallLSHandler));
}


