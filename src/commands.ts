import { ExtensionContext, window, commands, workspace, TerminalOptions, Disposable, Terminal } from "vscode";
import { fileOrDirectoryExists } from './utils';

type DisposableDict = Record<string, Disposable>;

let installProjectTerminal: Terminal | undefined;
let exportToServerTerminal: Terminal | undefined;

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
	return () => {
		if (!pythonPath || !fileOrDirectoryExists(pythonPath)) {
			window.showErrorMessage(`Could not run the export command. Make sure a valid venv is selected`);
		}
		if (!exportToServerTerminal) {
			const options: TerminalOptions = {
				name:"Export to Inmanta Server",
				message:"Running command 'inmanta export'"

			};
			exportToServerTerminal = window.createTerminal(options);
		}
		exportToServerTerminal.sendText(pythonPath+' -m inmanta.app -vv export');
		exportToServerTerminal.show();
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
 * @param {string} pythonPath The path to the Python interpreter.
 * @returns {() => void} A function that executes the 'inmanta project install' command in a VSCode terminal.
 */
export function createProjectInstallHandler(pythonPath: string){
	return () => {
		if (!pythonPath || !fileOrDirectoryExists(pythonPath)) {
			window.showErrorMessage(`Could not run the 'project install' command. Make sure a valid venv is selected`);
		}
		if (!installProjectTerminal) {
			const options: TerminalOptions = {
				name:"Inmanta Project Install",
				message:"Running command 'inmanta project install'"

			};
			installProjectTerminal = window.createTerminal(options);
		}
		installProjectTerminal.sendText(pythonPath+' -m inmanta.app project install');
		installProjectTerminal.show();
	};
}
