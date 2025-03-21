import { ExtensionContext, window, workspace, TerminalOptions, Terminal, WorkspaceFolder } from "vscode";
import { LanguageServer } from "./language_server";
import { fileOrDirectoryExists, registerCommand } from "./vscode_api";
import { traceLog } from "./logTracer";

/**
 * Terminal instances used for running Inmanta commands
 */
let installProjectTerminal: Terminal | undefined;
let exportToServerTerminal: Terminal | undefined;

/**
 * Class responsible for managing and registering Inmanta-specific VS Code commands.
 * Handles command registration, disposal, and execution for various Inmanta operations.
 */
export class InmantaCommands {
	/**
	 * The VS Code extension context
	 */
	context: ExtensionContext;

	/**
	 * Creates an instance of InmantaCommands.
	 * @param {ExtensionContext} context The VS Code extension context used for command registration
	 */
	constructor(context: ExtensionContext) {
		this.context = context;
	}

	/**
	 * Registers a command with VS Code.
	 * If a command with the given ID already exists, it will be disposed before registering the new command.
	 * @param {string} id The unique identifier for the command
	 * @param {(...args: any[]) => void} handler The function to execute when the command is triggered
	 */
	registerCommand(id: string, handler: (...args: any[]) => void) {
		this.context.subscriptions.push(registerCommand(id, handler));
	}

	/**
	 * Registers all Inmanta-specific commands for a given language server instance.
	 * This includes commands for exporting to server, activating language server,
	 * installing projects, and installing the language server itself.
	 * 
	 * @param {LanguageServer} languageServer The language server instance to register commands for
	 */
	registerCommands(languageServer: LanguageServer): void {
		traceLog(`Registering inmanta commands for language server responsible for ${languageServer.rootFolder.name} using ${languageServer.pythonPath} environment.`);

		this.registerCommand(`inmanta.exportToServer`, createHandlerExportCommand(languageServer.pythonPath));
		this.registerCommand(`inmanta.activateLS`, commandActivateLSHandler(languageServer.rootFolder));
		this.registerCommand(`inmanta.projectInstall`, createProjectInstallHandler(languageServer.pythonPath));
		this.registerCommand(`inmanta.installLS`, () => { languageServer.installLanguageServer(); });
	}
}

/**
 * Creates a handler for the 'exportToServer' command which exports the configuration to an Inmanta server.
 * The handler creates a new terminal if one doesn't exist and runs the export command using the specified Python interpreter.
 *
 * @param {string} pythonPath The path to the Python interpreter to use for the export
 * @returns {() => void} A function that executes the export command in a VS Code terminal
 * @throws Will show an error message if the Python path is invalid
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
 * Creates a handler function for activating the Inmanta language server.
 * Updates the 'inmanta.ls.enabled' configuration setting to true for either
 * the workspace folder or globally if no folder is specified.
 * 
 * @param {WorkspaceFolder} folder The workspace folder to enable the language server for
 * @returns {() => void} A function that enables the language server and shows a confirmation message
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
 * Creates a handler for installing an Inmanta project.
 * The handler creates a new terminal if one doesn't exist and runs the project install
 * command using the specified Python interpreter.
 * 
 * @param {string} pythonPath The path to the Python interpreter to use for installation
 * @returns {() => void} A function that executes the project install command in a VS Code terminal
 * @throws Will show an error message if the Python path is invalid
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
