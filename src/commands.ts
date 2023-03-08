import * as path from 'path';
import * as cp from 'child_process';

import { ExtensionContext, window, OutputChannel, Uri, commands, workspace, TerminalOptions, Disposable } from "vscode";
import { fileOrDirectoryExists } from './utils';

type DisposableDict = Record<string, Disposable>;

export class InmantaCommands {
	context: ExtensionContext;
	commands: DisposableDict = {};

	/**
    * Creates an instance of InmantaCommands.
    * @param {ExtensionContext} context The VSCode extension context.
    */
	constructor(context: ExtensionContext) {
		this.context = context;
	}
  	/**
	 * Registers a command with VSCode.
	 * If a command with the given ID already exists, it will be disposed before registering the new command.
	 * @param {string} id The ID of the command to register.
	 * @param {(...args: any[]) => void} handler The function to execute when the command is triggered.
	 */
	registerCommand(id:string, handler:(...args: any[]) => void){
		if (id in commands){
			commands[id].dispose();
		}
		const disposable = commands.registerCommand(id, handler);
		commands[id]= disposable;
		this.context.subscriptions.push(disposable);
	}

}

/**
 * Creates the Handler for the 'exportToServer' command which exports the configuration to an Inmanta server.
 *
 * @param {ExtensionContext} context The extension context object provided by VS Code.
 * @param {string} pythonPath The path to the Python interpreter.
 */
export function createHandlerExportCommand(pythonPath:string) {
	return (openedFileObj: object) => {
		const pathOpenedFile: string = String(openedFileObj);
		const cwdCommand: string = path.dirname(Uri.parse(pathOpenedFile).fsPath);
		const child = cp.spawn(pythonPath, ["-m", "inmanta.app", "-vv", "export"], {cwd: `${cwdCommand}`});
		let exportToServerChannel: OutputChannel = null; window.createOutputChannel("export to inmanta server");

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
}

/**
 * Handler function for activating the Inmanta language server.
 * Updates the 'inmanta.ls.enabled' configuration setting to true.
 * Shows an information message to the user indicating that the language server has been enabled.
 */
export const commandActivateLSHandler = () => {
	const config = workspace.getConfiguration();
	config.update('inmanta.ls.enabled', true);
	window.showInformationMessage("The Language server has been enabled");
};


/**
 * A function that creates a handler for installing an Inmanta project.
 * @param {string} activatePath The path to the venv activation script.
 * @returns {() => void} A function that executes the 'inmanta project install' command in a VSCode terminal.
 */
export function createProjectInstallHandler(activatePath: string){
	return () => {
		if (!activatePath || !fileOrDirectoryExists(activatePath)) {
			window.showErrorMessage(`Could not activate the venv to run the command. Make sure a valid venv is selected`);
		}

		const options: TerminalOptions = {
			name:"Inmanta Project Install",
			message:"Running command 'inmanta project install'"

		};
		const terminal = window.createTerminal(options);
		terminal.sendText('source '+ activatePath);
		terminal.sendText('inmanta project install');
		terminal.show();
	};
}

