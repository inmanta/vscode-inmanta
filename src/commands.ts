import { ExtensionContext, window, workspace, TerminalOptions, Terminal, WorkspaceFolder } from "vscode";
import { LanguageServer } from "./language_server";
import { fileOrDirectoryExists, registerCommand } from "./vscode_api";
import { traceLog } from "./logTracer";

let installProjectTerminal: Terminal | undefined;
let exportToServerTerminal: Terminal | undefined;

export class InmantaCommands {
	context: ExtensionContext;

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
	registerCommand(id: string, handler: (...args: any[]) => void) {
		this.context.subscriptions.push(registerCommand(id, handler));
	}

	registerCommands(languageServer: LanguageServer): void {
		traceLog(`Registering inmanta commands for language server responsible for ${languageServer.rootFolder.name} using ${languageServer.pythonPath} environment.`);
		// Register the disposable commands to the language server

		this.registerCommand(`inmanta.exportToServer`, createHandlerExportCommand(languageServer.pythonPath));
		this.registerCommand(`inmanta.activateLS`, commandActivateLSHandler(languageServer.rootFolder));
		this.registerCommand(`inmanta.projectInstall`, createProjectInstallHandler(languageServer.pythonPath));
		this.registerCommand(`inmanta.installLS`, () => { languageServer.installLanguageServer(); });
	}

}

/**
 * Creates the Handler for the 'exportToServer' command which exports the configuration to an Inmanta server.
 *
 * @param {ExtensionContext} context The extension context object provided by VS Code.
 * @param {string} pythonPath The path to the Python interpreter.
 */
export function createHandlerExportCommand(pythonPath: string) {
	return () => {
		if (!pythonPath || !fileOrDirectoryExists(pythonPath)) {
			window.showErrorMessage(`Could not run the export command. Make sure a valid venv is selected`);
		}
		if (!exportToServerTerminal) {
			const options: TerminalOptions = {
				name: "Export to Inmanta Server",
				message: "Running command 'inmanta export'"

			};
			exportToServerTerminal = window.createTerminal(options);
		}
		exportToServerTerminal.sendText(pythonPath + ' -m inmanta.app -vv export');
		exportToServerTerminal.show();
	};
}

/**
 * Handler function for activating the Inmanta language server.
 * Updates the 'inmanta.ls.enabled' configuration setting to true.
 * Shows an information message to the user indicating that the language server has been enabled.
 */
export function commandActivateLSHandler(folder: WorkspaceFolder) {

	return () => {
		if (!folder) {
			// Not in a workspace
			const config = workspace.getConfiguration();
			window.showInformationMessage("The Language server has been enabled.");
			config.update('inmanta.ls.enabled', true);

		} else {
			// In a workspace
			const multiRootConfigForResource = workspace.getConfiguration('inmanta', folder);
			window.showInformationMessage(`The Language server has been enabled for folder ${folder.name}.`);
			multiRootConfigForResource.update('ls.enabled', true);
		}
	};

};


/**
 * A function that creates a handler for installing an Inmanta project.
 * @param {string} pythonPath The path to the Python interpreter.
 * @returns {() => void} A function that executes the 'inmanta project install' command in a VSCode terminal.
 */
export function createProjectInstallHandler(pythonPath: string) {
	return () => {
		if (!pythonPath || !fileOrDirectoryExists(pythonPath)) {
			window.showErrorMessage(`Could not run the 'project install' command. Make sure a valid venv is selected.`);
		}
		if (!installProjectTerminal) {
			const options: TerminalOptions = {
				name: "Inmanta Project Install",
				message: "Running command 'inmanta project install'"

			};
			installProjectTerminal = window.createTerminal(options);
		}
		const command = pythonPath + ' -m inmanta.app project install';
		installProjectTerminal.sendText(command);
		installProjectTerminal.show();
	};
}
