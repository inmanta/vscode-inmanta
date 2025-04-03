'use strict';

import * as net from 'net';
import * as cp from 'child_process';
import * as os from 'os';
import * as path from "path";
import * as fs from "fs";
import getPort from 'get-port';

import { commands, ExtensionContext, OutputChannel, window, workspace, Uri, WorkspaceFolder, Location, Definition, Position, TextDocument } from 'vscode';
import { RevealOutputChannelOn, LanguageClientOptions, ErrorHandler, Message, ErrorHandlerResult, ErrorAction, CloseHandlerResult, CloseAction, ProvideDefinitionSignature, CancellationToken } from 'vscode-languageclient';
import { LanguageClient, ServerOptions } from 'vscode-languageclient/node';
import { Mutex } from 'async-mutex';

import { v4 as uuidv4 } from 'uuid';
import { getLanguageMap } from './extension';
import { pythonVersionSupported, resolveInterpreter } from './python';
import { traceError, traceInfo, traceLog, traceWarn } from './logTracer';
import { fileOrDirectoryExists, isLocation } from './vscode_api';

const REQUIREMENTS_PATH = path.join(__dirname, "..", "requirements.txt");

export enum LanguageServerDiagnoseResult {
	wrongInterpreter,
	wrongPythonVersion,
	languageServerNotInstalled,
	noVenv,
	wrongLanguageServer,
	unknown,
	ok,
}

export const DiagnoseResultMap = new Map<LanguageServerDiagnoseResult, string>([
	[LanguageServerDiagnoseResult.wrongInterpreter, "The selected interpreter is not valid"],
	[LanguageServerDiagnoseResult.wrongPythonVersion, "The selected interpreter is not supported"],
	[LanguageServerDiagnoseResult.languageServerNotInstalled, "The Inmanta Language Server is not installed"],
	[LanguageServerDiagnoseResult.noVenv, "No virtual environment selected"],
	[LanguageServerDiagnoseResult.wrongLanguageServer, "The Inmanta Language Server is not the correct version"],
	[LanguageServerDiagnoseResult.unknown, "An unknown error occurred"],
	[LanguageServerDiagnoseResult.ok, "The Inmanta Language Server is ready to start"],
]);


/**
 * An implementation of the ErrorHandler interface for the language server client.
 */
export class LsErrorHandler implements ErrorHandler {
	folder: WorkspaceFolder;
	constructor(folder: WorkspaceFolder) {
		this.folder = folder;
	}
	async error(error: Error, _message: Message | undefined, _count: number | undefined): Promise<ErrorHandlerResult> {
		const languageServer: LanguageServer = getLanguageMap().get(this.folder.uri.toString());

		if (languageServer === undefined) {
			traceError("Language Server not found for folder: ", this.folder.uri.toString());
			return;
		}
		const languageServerDiagnose = await languageServer.canServerStart();
		if (languageServerDiagnose === LanguageServerDiagnoseResult.unknown) {
			traceError("Language Server unexpected error: ", error);
			window.showErrorMessage(error.name + ": " + error.message);
		}
		if (languageServerDiagnose !== LanguageServerDiagnoseResult.ok) {
			traceLog("Proposing solution for language server error");
			await languageServer.proposeSolution(languageServerDiagnose, uuidv4());
		}
		return { action: ErrorAction.Shutdown };
	}

	closed(): CloseHandlerResult {
		return { action: CloseAction.DoNotRestart };
	}

}

export class LanguageServer {
	mutex = new Mutex();
	client: LanguageClient;
	lsOutputChannel: OutputChannel = null;
	serverProcess: cp.ChildProcess;
	context: ExtensionContext;
	pythonPath: string;
	rootFolder: WorkspaceFolder;
	diagnoseId: string;
	errorHandler: LsErrorHandler;
	/**
	 * Initialize a LanguageServer instance with the given context and PythonExtension instance.
	 *
	 * @param {ExtensionContext} context the extension context.
	 * @param {Extension<any>} pythonExtension the Python extension.
	 */
	constructor(context: ExtensionContext, pythonPath: string, rootFolder: WorkspaceFolder, errorHandler: LsErrorHandler) {
		traceLog("Creating new language server...");

		this.context = context;
		this.pythonPath = pythonPath;
		this.rootFolder = rootFolder;
		this.errorHandler = errorHandler;
	}


	/**
	 * Returns an array of string(s) representing the version of the Inmanta Language Server
	 * that needs to be installed. The function checks if the environment variable INMANTA_LS_PATH is
	 * set and uses it to install the LS from the specified path in editable mode. If the environment variable is not set,
	 * it checks for the presence of requirements.txt file and installs the LS from it.
	 * If requirements.txt file is not present, it installs the latest version of Inmanta Language Server.
	 *
	 * @returns {string[]} An array of string(s) representing the version of the Inmanta Language Server to be installed.
	 */
	languageServerVersionToInstall(): string[] {
		const lsPath = process.env.INMANTA_LS_PATH;

		if (lsPath) {
			traceLog(`Installing Language Server from local source "${lsPath}"`);
			return ["-e", lsPath];
		}

		// Check for the presence of requirements.txt
		if (fs.existsSync(REQUIREMENTS_PATH)) {
			traceLog(`Installing Language Server from requirements file "${REQUIREMENTS_PATH}"`);
			return ["-r", REQUIREMENTS_PATH];
		}

		return ["inmantals"];
	}

	/**
	 * Returns the version of the installed Inmanta Language Server, or null if it's not installed.
	 *
	 * @returns {string | null} The version of the installed Inmanta Language Server, or null if it's not installed.
	 */
	getInstalledInmantaLSVersion(): string | null {
		try {
			const result = cp.spawnSync(this.pythonPath, ["-m", "pip", "show", "inmantals"], { encoding: "utf-8" });
			if (result.status === 0) {
				const match = result.stdout.match(/Version: (.+)/);
				return match ? match[1] : null;
			}
		} catch (error) {
			traceError(`Error: Couldn't get Inmanta LS version: ${error.message}`);
		}
		return null;
	}

	/**
	 * Checks if the Inmanta Language Server is installed in editable mode.
	 * the language server is installed wit pip install -e, 
	 * which causes your checked out version of the code to be installed in the venv, without copying it.
	 * I.e. when you edit the code, you edit the installed code, not the one coming from artifacts.
	 * For development this is super handy, because you don't need to package it every time
	 * 
	 * @returns {string | null} True if inmantals is installed in editable mode, else false
	 */
	isEditableInstall(): boolean {
		try {
			// The os.platform() method in Node.js returns win32 for both 32-bit and 64-bit Windows systems.
			const isWindows = os.platform() === 'win32';
			const command = isWindows
				? `${this.pythonPath} -m pip list --editable | findstr inmantals`
				: `${this.pythonPath} -m pip list --editable | grep inmantals`;

			const inmantals = cp.execSync(command).toString();

			if (inmantals) {
				return true;
			}
			return false;
		} catch (error) {
			traceError(`Error checking if inmantals is installed in editable mode: ${error.message}`);
		}
		return false;
	}

	/**
	 * Checks if the correct version of the Inmanta Language Server is installed.
	 *
	 * @returns {boolean} True if the correct version of the Inmanta Language Server is installed, false otherwise.
	 */
	isCorrectInmantaLSVersionInstalled(): boolean {
		// The LS is installed in editable mode via the env var
		if (process.env.INMANTA_LS_PATH || this.isEditableInstall()) {
			traceInfo("Inmanta LS is (already) installed in editable mode");
			return true;
		}
		// No requirements specified
		if (!fs.existsSync(REQUIREMENTS_PATH)) {
			traceInfo("No requirements specified, assuming correct version of Inmanta LS is installed");
			return true;
		}

		// Get the expected version from requirement.txt
		let expectedVersion = null;
		let operator = "==";
		const requirementTxtContent = fs.readFileSync(REQUIREMENTS_PATH, "utf-8");
		const inmantaLSPattern = /^inmantals(==|~=).*$/gm;
		const inmantaLSLine = requirementTxtContent.match(inmantaLSPattern)[0];
		if (inmantaLSLine) {
			operator = inmantaLSLine.match(/(==|~=)/)?.[0] ?? "==";
			expectedVersion = inmantaLSLine.split(/(==|~=)/)[2];
		}

		if (!expectedVersion) {
			// requirement.txt does not specify inmantals, no requirements specified
			traceInfo("No version specified in requirements.txt, assuming correct version of Inmanta LS is installed");
			return true;
		}

		// Get the installed version of inmantals
		const installedVersion = this.getInstalledInmantaLSVersion();

		// Compare the expected and installed versions
		if (operator === "~=") {
			const [expectedMajor, expectedMinor, expectedPatch] = expectedVersion.split(".").map((num) => parseInt(num));
			const [installedMajor, installedMinor, installedPatch] = installedVersion.split(".").map((num) => parseInt(num));

			traceInfo(`Expected version: ${expectedMajor}.${expectedMinor}.${expectedPatch}`);
			traceInfo(`Installed version: ${installedMajor}.${installedMinor}.${installedPatch}`);

			return expectedMajor === installedMajor && expectedMinor === installedMinor && installedPatch >= expectedPatch;
		}
		return installedVersion === expectedVersion;
	}

	isVirtualEnv(pythonPath?: string): boolean {
		try {
			const script = "import sys; real_prefix = getattr(sys, \'real_prefix\', None); base_prefix = getattr(sys, \'base_prefix\', sys.prefix); running_in_virtualenv = (base_prefix or real_prefix) != sys.prefix; print(running_in_virtualenv)";
			const result = cp.spawnSync(pythonPath, ["-c", script]);

			traceInfo(`Checking if interpreter is in a virtual environment`);

			return result.stdout.toString().trim() === 'True';
		} catch (error) {
			traceError(`Error, Interpreter not in a virtual environment: ${error.message}`);
			return false;
		}
	}

	/**
	 * updates the python path used by the LS.
	 *
	 * @param {string} newPath the new python path
	 */
	async updatePythonPath(newPath: string, outermost: Uri): Promise<void> {
		traceLog(`Comparing outermost: ${outermost} to rooturi: ${this.rootFolder.uri.toString()}`);

		// Compare URI strings instead of URI objects
		if (outermost.toString() === this.rootFolder.uri.toString() || !outermost) {
			const oldPath = this.pythonPath;
			this.pythonPath = newPath;
			traceLog(`Language server python path changed from ${oldPath} to ${newPath}`);

			const canStart = await this.canServerStart(newPath);

			if (canStart === LanguageServerDiagnoseResult.ok) {
				await this.startOrRestartLS(false, canStart);
			}
			else {
				traceWarn(`Language server can't start with interpreter ${newPath}`);
				this.diagnoseId = uuidv4();
				return this.proposeSolution(canStart, this.diagnoseId);
			}
		} else {
			traceLog(`Skipping python path update for ${this.rootFolder.uri.toString()} as it doesn't match ${outermost.toString()}`);
		}
	}

	/**
	 * Check if the server can start using the provided interpreter.
	 * If no interpreter is provided, this check will be performed against the interpreter provided during
	 * instantiation of this LanguageServer.
	 *
	 * @param {string} pythonPath the new python path

	 * @returns {Promise<LanguageServerDiagnoseResult>} The diagnose result
	 */
	async canServerStart(pythonPath?: string): Promise<LanguageServerDiagnoseResult> {
		const localPythonPath = pythonPath ?? this.pythonPath;

		// check if we are running in a venv
		if (!this.isVirtualEnv(localPythonPath)) {
			return LanguageServerDiagnoseResult.noVenv;
		}

		const interpreter = await resolveInterpreter([localPythonPath]);

		// check if the interpreter is set
		if (!interpreter) {
			return LanguageServerDiagnoseResult.wrongInterpreter;
		}

		// Check the version of the interpreter
		if (!pythonVersionSupported(interpreter)) {
			return LanguageServerDiagnoseResult.wrongPythonVersion;
		}

		// Check if a language server is installed
		if (!this.getInstalledInmantaLSVersion()) {
			return LanguageServerDiagnoseResult.languageServerNotInstalled;
		}

		// Check if the correct language server is installed
		if (!this.isCorrectInmantaLSVersionInstalled()) {
			return LanguageServerDiagnoseResult.wrongLanguageServer;
		}

		return LanguageServerDiagnoseResult.ok;
	}


	/**
	 * Propose a solution according to the given error.
	 *
	 * @param {LanguageServerDiagnoseResult} error the extension language server error for wich we propose a solution
	 * @param {string} diagnoseId a uuid to identify the diagnose
	 */
	async proposeSolution(error: LanguageServerDiagnoseResult, diagnoseId: string) {
		let response;
		switch (error) {
			case LanguageServerDiagnoseResult.wrongInterpreter:
				await this.selectInterpreter(diagnoseId);
				break;
			case LanguageServerDiagnoseResult.wrongPythonVersion:
				response = await window.showErrorMessage(`The Inmanta Language Server requires at least Python 3.12, but the provided interpreter (${this.pythonPath}) is an older version.`, "Setup assistant");

				if (response === "Setup assistant") {
					commands.executeCommand(`workbench.action.openWalkthrough`, `Inmanta.inmanta#inmanta.walkthrough`, false);
				};
				break;
			case LanguageServerDiagnoseResult.languageServerNotInstalled:
				this.proposeInstallLS(diagnoseId, LanguageServerDiagnoseResult.languageServerNotInstalled);
				break;
			case LanguageServerDiagnoseResult.wrongLanguageServer:
				this.proposeInstallLS(diagnoseId, LanguageServerDiagnoseResult.wrongLanguageServer);
				break;
			case LanguageServerDiagnoseResult.noVenv:
				response = await window.showErrorMessage(`The Inmanta Language Server requires a virtual environment to be selected`, "Setup assistant");

				if (response === "Setup assistant") {
					commands.executeCommand(`workbench.action.openWalkthrough`, `Inmanta.inmanta#inmanta.walkthrough`, false);
				};
				break;
			case LanguageServerDiagnoseResult.unknown:
				response = await window.showErrorMessage(`The Inmanta Language Server failed to start`, "Setup assistant");
				if (response === "Setup assistant") {
					commands.executeCommand(`workbench.action.openWalkthrough`, `Inmanta.inmanta#inmanta.walkthrough`, false);
				};
				break;
		}
	}

	/**
	 * Prompt the user to select a Python interpreter.
	 *
	 * @param {string} diagnoseId a uuid to identify the diagnose
	 * @returns {Promise<any>} A Promise that resolves to the result of startOrRestartLS() after the interpreter is selected.
	 *    If the user cancels the selection, a Promise rejection with the message "No Interpreter Selected" is returned.
	 */
	async selectInterpreter(diagnoseId: string): Promise<any> {
		const response = await window.showWarningMessage(`No interpreter or invalid interpreter selected`, 'Select interpreter');

		if (response === 'Select interpreter') {
			return await commands.executeCommand('python.setInterpreter');
		}
		if (this.diagnoseId !== diagnoseId) {
			//another diagnose has been run in the mean time
			return Promise.resolve();
		} else {
			const response2 = await window.showErrorMessage("The Inmanta language server could not start as no virtual environment is selected", "Setup assistant");
			if (response2 === "Setup assistant") {
				return commands.executeCommand(`workbench.action.openWalkthrough`, `Inmanta.inmanta#inmanta.walkthrough`, false);
			}
			return Promise.reject("No Interpreter Selected");
		}
	}

	/**
	 * Propose to install the Language server.
	 * If the Python interpreter is not set or invalid, prompts the user to select a valid interpreter.
	 *
	 * @param {string} diagnoseId a uuid to identify the diagnose
	 * @returns {Promise<any>} - A Promise that resolves to the result of `installLanguageServer()` after the server is installed.
	 * If the user declines to install the server, returns a Promise that rejects with an error message.
	 */
	async proposeInstallLS(diagnoseId: string, reason: LanguageServerDiagnoseResult) {
		if (!this.pythonPath || !fileOrDirectoryExists(this.pythonPath)) {
			await this.selectInterpreter(diagnoseId);
		}
		const msg = reason === LanguageServerDiagnoseResult.wrongLanguageServer
			? "A new version of the Inmanta Language Server is available. Do you want to update? "
			: `Inmanta Language Server not installed. Install the Language server in ${this.pythonPath}? `;
		const response = await window.showWarningMessage(msg, 'Yes', 'No');
		if (response === 'Yes') {
			await this.installLanguageServer();
			return this.startOrRestartLS(true);
		}
		if (this.diagnoseId !== diagnoseId) {
			//another diagnose has been run in the mean time
			return Promise.resolve();
		} else {
			const response = await window.showErrorMessage("The Inmanta language server could not start as the language server was not installed", "Setup assistant");
			if (response === "Setup assistant") {
				return commands.executeCommand(`workbench.action.openWalkthrough`, `Inmanta.inmanta#inmanta.walkthrough`, false);
			};
			return Promise.reject("Inmanta Language Server was not installed");
		}

	}

	/**
	 * Install the Inmanta Language Server and start it if specified.
	 * @returns {Promise<void>}
	 */
	async installLanguageServer(): Promise<void> {
		traceLog(`LS install requested for root folder ${JSON.stringify(this.rootFolder)}`);

		this.diagnoseId = uuidv4();
		if (!this.pythonPath || !fileOrDirectoryExists(this.pythonPath)) {
			return this.selectInterpreter(this.diagnoseId);
		}

		const cmdArgs: string[] = ["-m", "pip", "install"];
		cmdArgs.push(...this.languageServerVersionToInstall());

		window.showInformationMessage(`Installing Inmanta Language server in ${this.pythonPath}. This may take a few seconds`);
		traceLog("installing LS  with: " + cmdArgs.join(' '));

		const child = cp.spawnSync(this.pythonPath, cmdArgs);

		traceInfo(`Inmanta Language Server install exited with code ${child.status}`);

		if (child.status !== 0) {
			traceError(`Can not start server and client ${child.stderr.toString()}`);
			const response = await window.showErrorMessage(`Inmanta Language Server install failed with code ${child.status}, ${child.stderr}`, "Setup assistant");
			if (response === "Setup assistant") {
				return commands.executeCommand(`workbench.action.openWalkthrough`, `Inmanta.inmanta#inmanta.walkthrough`, false);
			};
			return Promise.reject("failed to install LS");
		} else {
			window.showInformationMessage("Inmanta Language server was installed successfully");
			return Promise.resolve();
		}
	}

	/**
	 * Provide the definition of a symbol at a given position in the document.
	 * @param {TextDocument} document The text document to get the definition from.
	 * @param {Position} position The position within the document to get the definition for.
	 * @param {CancellationToken} token A cancellation token.
	 * @param {ProvideDefinitionSignature} next The next provider to call.
	 * @returns {Promise<Location | Location[] | undefined>} A Promise that resolves to a
	 * Location, an array of Location, or undefined. If an array of Location is
	 * returned by 'next', the locations are filtered to remove any that do not have a valid uri path.
	 * If the Location returned by 'next' has an undefined uri path, returns undefined.
	 */
	private async middlewareProvideDefinition(
		document: TextDocument,
		position: Position,
		token: CancellationToken,
		next: ProvideDefinitionSignature
	): Promise<Location | Location[] | undefined> {
		const definition: Location | Location[] = await next(document, position, token) as Definition;
		if (Array.isArray(definition)) {
			const filteredDefinition: Location[] = definition.filter(
				(loc): loc is Location => (isLocation(loc) && loc.uri.path !== "/undefined")
			);
			return filteredDefinition;
		} else if (isLocation(definition) && definition.uri.path !== "/undefined") {
			return definition;
		} else {
			return undefined;
		}
	}


	/**
	 * Get options for initializing the language client.
	 * @returns {Promise<LanguageClientOptions>} A Promise that resolves to an object containing options for the language client,
	 * 		including document selector, error handler, output channel settings, and initialization options.
	 * @throws {Error} Throws an error if a file is opened instead of a folder.
	 */
	private async getClientOptions(): Promise<LanguageClientOptions> {
		if (this.context.storageUri === undefined) {
			window.showWarningMessage("A folder should be opened instead of a file in order to use the inmanta extension.");
			throw Error("A folder should be opened instead of a file in order to use the inmanta extension.");
		}
		const folder = workspace.getWorkspaceFolder(this.rootFolder.uri);


		let compilerVenv: string | undefined;
		let repos: string | undefined;
		let pipConfig: Map<string, string | boolean> | undefined;

		if (!folder) {
			// Not in a workspace
			compilerVenv = workspace.getConfiguration('inmanta').compilerVenv;
			repos = workspace.getConfiguration('inmanta').repos;
			pipConfig = workspace.getConfiguration('inmanta').pip;
		} else {
			// In a workspace
			const multiRootConfigForResource = workspace.getConfiguration('inmanta', folder);
			compilerVenv = multiRootConfigForResource.get('compilerVenv');
			repos = multiRootConfigForResource.get('repos');
			pipConfig = multiRootConfigForResource.get('pip');
		}

		if (this.lsOutputChannel === null) {
			this.lsOutputChannel = window.createOutputChannel(`Inmanta Language Server[${this.rootFolder.uri.toString()}]`);
		}

		const clientOptions: LanguageClientOptions = {
			// Register the server for inmanta documents living under the root folder.
			documentSelector: [{ scheme: 'file', language: 'inmanta' }],
			middleware: {
				provideDefinition: this.middlewareProvideDefinition
			},
			outputChannel: this.lsOutputChannel,
			revealOutputChannelOn: RevealOutputChannelOn.Info,
			errorHandler: this.errorHandler,
			initializationOptions: {
				compilerVenv: compilerVenv, //this will be ignore if inmanta-core>=6
				repos: repos,
				pip: pipConfig,
			},
			workspaceFolder: this.rootFolder,
		};
		return clientOptions;

	}

	/**
	 * Starts an Inmanta Language Server and client.
	 * This function should always run under the `mutex` lock.
	 * @returns {Promise<void>} A Promise that resolves when the server and client are started successfully.
	 */
	private async startServerAndClient(): Promise<void> {
		traceLog("Start server and client");
		let clientOptions;
		try {
			clientOptions = await this.getClientOptions();
			traceLog("Retrieved client options");
		} catch (err) {
			traceError("Error occured while retrieving client options:" + err);
			return Promise.reject("failed retrieving client options");
		}
		try {
			if (os.platform() === "win32") {
				traceLog("Windows OS detected, Starting TCP server");
				return this.startTcp(clientOptions);
			} else {
				traceLog("Starting pipe server");
				return this.startPipe(clientOptions);
			}
		} catch (err) {
			traceError(`Could not start Language Server: ${err.message}`);
			const response = await window.showErrorMessage('Inmanta Language Server: rejected to start' + err.message, "Setup assistant");
			if (response === "Setup assistant") {
				return commands.executeCommand(`workbench.action.openWalkthrough`, `Inmanta.inmanta#inmanta.walkthrough`, false);
			};
			return Promise.reject("failed to start LS");
		}
	}

	/**
	 * Starts the TCP server and the Inmanta Language Server.
	 * This function should always run under the `mutex` lock.
	 *
	 * @param clientOptions The options for the language client.
	 */
	private async startTcp(clientOptions: LanguageClientOptions) {
		if (this.client) {
			return;
		}
		const host = "127.0.0.1";
		// Get a random free port on 127.0.0.1
		const serverPort = await getPort({ host: host });

		const options: cp.SpawnOptionsWithoutStdio = {};
		if (process.env.INMANTA_LS_LOG_PATH) {
			traceInfo(`Language Server log file has been manually set to "${process.env.INMANTA_LS_LOG_PATH}"`);
			options.env = {
				"LOG_PATH": process.env.INMANTA_LS_LOG_PATH
			};
		}

		this.serverProcess = cp.spawn(this.pythonPath, ["-m", "inmantals.tcpserver", serverPort.toString()], options);
		let started = false;

		this.serverProcess.stderr.on('data', (data) => {
			this.lsOutputChannel.appendLine(`stderr: ${data}`);
		});
		this.serverProcess.stdout.on('data', (data) => {
			this.lsOutputChannel.appendLine(`stdout: ${data}`);
			if (data.includes("starting")) {
				started = true;
			}
		});


		const timeout: number = 10000;
		const start = Date.now();
		// Wait for server to start
		await new Promise<void>((resolve, reject) => {
			const interval = setInterval(() => {
				if (Date.now() - start > timeout) {
					window.showErrorMessage("Couldn't start language server");
					clearInterval(interval);
					reject("Couldn't start language server");
				}
				if (started) {
					clearInterval(interval);
					resolve();
				}
			}, 500);
		});

		const serverOptions: ServerOptions = function () {
			const socket = net.connect({ port: serverPort, host: host });
			const streamInfo = {
				reader: socket,
				writer: socket
			};
			return Promise.resolve(streamInfo);
		};

		this.client = new LanguageClient('inmanta-ls', 'Inmanta Language Server', serverOptions, clientOptions);
		// Create the language client and start the client.

		traceLog(`Starting Language Client with options: ${JSON.stringify({
			serverOptions: serverOptions,
			clientOptions: clientOptions
		}, null, 2)}`);

		try {
			await this.client.start();
		} catch (error) {
			traceError(`Failed to start language client: ${error.message}`);
			window.showErrorMessage(`Failed to start language client: ${error.message}`);
		}
	}

	/**
	 * Starts the Inmanta Language Server by creating a new LanguageClient and starting it with the given clientOptions.
	 * This function should always run under the `mutex` lock.
	 *
	 * @param {LanguageClientOptions} clientOptions The options for the LanguageClient.
	 */
	async startPipe(clientOptions: LanguageClientOptions) {
		if (this.client) {
			return;
		}
		traceLog(`Python path is ${this.pythonPath}`);

		const serverOptions: ServerOptions = {
			command: this.pythonPath,
			args: ["-m", "inmantals.pipeserver"],
			options: {
				env: {}
			}
		};

		if (process.env.INMANTA_LS_LOG_PATH) {
			traceLog(`Language Server log file has been manually set to "${process.env.INMANTA_LS_LOG_PATH}"`);
			serverOptions.options.env["LOG_PATH"] = process.env.INMANTA_LS_LOG_PATH;
		}

		// Create the language client and start the client.
		traceLog(`server options ${JSON.stringify(serverOptions)}`);

		this.client = new LanguageClient('inmanta-ls', 'Inmanta Language Server', serverOptions, clientOptions);

		traceLog("Waiting for language Client to start");
		traceLog(`Starting Language Client with options: ${JSON.stringify({
			serverOptions: serverOptions,
			clientOptions: clientOptions
		}, null, 2)}`);

		try {
			await this.client.start();
		} catch (error) {
			traceError(`Failed to start language client: ${error.message}`);
			window.showErrorMessage(`Failed to start language client: ${error.message}`);
		}
	}

	/**
	 * Starts or restarts the language server.
	 * @param {boolean} init Whether to start the server or restart it.
	 * @returns {Promise<void>}
	 */
	async startOrRestartLS(init: boolean = false, canStart?: LanguageServerDiagnoseResult): Promise<void> {
		this.diagnoseId = uuidv4();

		traceLog(`Starting or restarting LS for root folder ${this.rootFolder.uri.toString()}`);

		const _canStart: LanguageServerDiagnoseResult = canStart ?? await this.canServerStart();

		if (_canStart !== LanguageServerDiagnoseResult.ok) {
			traceWarn(`Can't start LS for root folder ${this.rootFolder.uri.toString()} : ${DiagnoseResultMap.get(_canStart)}`);
			return this.proposeSolution(_canStart, this.diagnoseId);
		}

		if (init) {
			traceLog("starting Language Server");
		} else {
			traceLog("restarting Language Server");
		}
		const enable: boolean = workspace.getConfiguration('inmanta').ls.enabled;
		await this.mutex.runExclusive(async () => {
			await this.stopServerAndClient(false);
			if (enable) {
				await this.startServerAndClient();
				window.showInformationMessage(`The Language server has been enabled for folder ${this.rootFolder.name}`);
			}
		});
	}

	/**
	 * Stops the language server and its client.
	 *
	 * @param {boolean} acquireLock - If this parameter is set to false, 
	 * the `mutex` lock must be acquired by the caller.
	 * Otherwise this method acquires the lock itself.
	 */
	async stopServerAndClient(acquireLock: boolean = true) {
		traceInfo("Stopping server and client...");
		if (acquireLock) {
			await this.mutex.runExclusive(async () => {
				await this._stopServerAndClient();
			});
		} else {
			await this._stopServerAndClient();
		}
	}

	/* 
	 * Stops the language server and its client.
	 * This function should always run under the `mutex` lock.
	 */
	async _stopServerAndClient() {
		if (this.client) {
			if (this.client.needsStop()) {
				await this.client.stop();
			}
			this.client = undefined;
		}
		if (this.serverProcess) {
			if (!this.serverProcess.exitCode) {
				this.serverProcess.kill();
			}
			this.serverProcess = undefined;
		}
	}

	cleanOutputChannel() {
		this.lsOutputChannel.dispose();
	}
}
