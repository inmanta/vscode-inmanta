'use strict';

import * as net from 'net';
import * as cp from 'child_process';
import * as os from 'os';
import * as path from "path";
import * as fs from "fs";
import getPort from 'get-port';

import { commands, ExtensionContext, OutputChannel, window, workspace, Uri, WorkspaceFolder} from 'vscode';
import { RevealOutputChannelOn, LanguageClientOptions, integer, ErrorHandler, Message, ErrorHandlerResult, ErrorAction, CloseHandlerResult, CloseAction} from 'vscode-languageclient';
import { LanguageClient, ServerOptions } from 'vscode-languageclient/node';
import { Mutex } from 'async-mutex';
import { fileOrDirectoryExists, log } from './utils';
import { v4 as uuidv4 } from 'uuid';
import { getLanguageMap } from './extension';

const REQUIREMENTS_PATH = path.join(__dirname, "..", "requirements.txt");

export enum LanguageServerDiagnoseResult {
	wrongInterpreter,
	wrongPythonVersion,
	languageServerNotInstalled,
	wrongLanguageServer,
	unknown,
	ok,
  }


/**
 * An implementation of the ErrorHandler interface for the language server client.
 */
export class LsErrorHandler implements ErrorHandler{
	folder: WorkspaceFolder;
	constructor(folder: WorkspaceFolder) {
		this.folder = folder;
	}
	async error(error: Error, message: Message | undefined, count: number | undefined): Promise<ErrorHandlerResult> {
		let languageServer: LanguageServer = getLanguageMap().get(this.folder.uri.toString());

		if (languageServer === undefined) {
			return;
		}
		const languageServerDiagnose = await languageServer.canServerStart();
		if (languageServerDiagnose === LanguageServerDiagnoseResult.unknown){
			window.showErrorMessage(error.name+": "+error.message);
		}
		if (languageServerDiagnose !== LanguageServerDiagnoseResult.ok){
			await languageServer.proposeSolution(languageServerDiagnose, uuidv4());
		}
		return {action: ErrorAction.Shutdown};
	}

	closed(): CloseHandlerResult{
		return {action: CloseAction.DoNotRestart};
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
		log("Creating new language server...");

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
		const version = [];

		if (process.env.INMANTA_LS_PATH) {
		  version.push("-e", process.env.INMANTA_LS_PATH);
		  log(`Installing Language Server from local source "${process.env.INMANTA_LS_PATH}"`);
		} else {
		  // Check for the presence of requirements.txt
		  if (fs.existsSync(REQUIREMENTS_PATH)) {
			version.push("-r", REQUIREMENTS_PATH);
			log(`Installing Language Server from requirements file "${REQUIREMENTS_PATH}"`);
		  } else {
			version.push("inmantals");
		  }
		}

		return version;
	}

	/**
	 * Returns the version of the installed Inmanta Language Server, or null if it's not installed.
	 *
	 * @returns {string | null} The version of the installed Inmanta Language Server, or null if it's not installed.
	 */
	getInstalledInmantaLSVersion(): string | null {
		try {
		  const output = cp.execSync(`${this.pythonPath} -m pip show inmantals`).toString();
		  const versionMatch = output.match(/^Version: (.+)$/m);
		  if (versionMatch) {
			return versionMatch[1];
		  }
		} catch (error) {}
		return null;
	}

	/**
	 * Checks if the correct version of the Inmanta Language Server is installed.
	 *
	 * @returns {boolean} True if the correct version of the Inmanta Language Server is installed, false otherwise.
	 */
	isCorrectInmantaLSVersionInstalled(): boolean {
		// The LS is installed in editable mode via the env var
		if (process.env.INMANTA_LS_PATH) {
			return true;
		}
		// No requirements specified
		if (!fs.existsSync(REQUIREMENTS_PATH)) {
			return true;
		}
		// Get the expected version from requirement.txt
		let expectedVersion = null;
		const requirementTxtContent = fs.readFileSync(REQUIREMENTS_PATH, "utf-8");
		const inmantaLSPattern = /^inmantals[=<>].*$/gm;
		const inmantaLSLine = requirementTxtContent.match(inmantaLSPattern)?.[0];
		if (inmantaLSLine) {
			expectedVersion = inmantaLSLine.split(/[<=>]{2}/)[1];
		}

		if (!expectedVersion) {
		  // requirement.txt does not specify inmantals, no requirements specified
		  return true;
		}

		// Get the installed version of inmantals
		const installedVersion = this.getInstalledInmantaLSVersion();

		// Compare the expected and installed versions
		return installedVersion === expectedVersion;
	}

	/**
	 * updates the python path used by the LS.
	 *
	 * @param {string} newPath the new python path
	 */
	async updatePythonPath(newPath: string, outermost: Uri): Promise<void> {
		log(`Comparing outermost: ${outermost} to rooturi: ${this.rootFolder.uri.toString()}`);

		if (outermost === this.rootFolder.uri) {
			const canStart = await this.canServerStart(newPath);

			if (canStart === LanguageServerDiagnoseResult.ok) {
				this.pythonPath = newPath;
				log(`Language server python path changed to ${newPath}`);
				this.startOrRestartLS(false, canStart);
			}
			else {
				log(`Language server can't start with interpreter ${newPath}`);

				this.diagnoseId = uuidv4();
				return this.proposeSolution(canStart, this.diagnoseId);
			}
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
	async canServerStart(pythonPath?: string):Promise<LanguageServerDiagnoseResult>{
		if (pythonPath === undefined) {
			pythonPath = this.pythonPath;
		}
		if (!pythonPath || !fileOrDirectoryExists(pythonPath)) {
			return LanguageServerDiagnoseResult.wrongInterpreter;
		}
		const script = "import sys\n" +
			"if sys.version_info[0] != 3 or sys.version_info[1] < 6:\n" +
			"  sys.exit(4)\n" +
			"try:\n" +
			"  import inmantals\n" +
			"  sys.exit(0)\n" +
			"except ModuleNotFoundError:\n" +
			"  sys.exit(3)";
			"except ModuleNotFoundError:\n" +
			"  print(e)\n" +
			"  sys.exit(5)";

		let spawnResult = cp.spawnSync(pythonPath, ["-c", script]);
		const stdout = spawnResult.stdout.toString();
		if (spawnResult.status === 4) {
			return LanguageServerDiagnoseResult.wrongPythonVersion;
		} else if (spawnResult.status === 3) {
			return LanguageServerDiagnoseResult.languageServerNotInstalled;
		} else if (spawnResult.status !== 0) {
			log("can not start server due to: "+stdout);
			return LanguageServerDiagnoseResult.unknown;
		}
		if(!this.isCorrectInmantaLSVersionInstalled()){
			return LanguageServerDiagnoseResult.wrongLanguageServer;
		}
		else{
			return LanguageServerDiagnoseResult.ok;
		}
	}


	/**
	 * Propose a solution according to the given error.
	 *
	 * @param {LanguageServerDiagnoseResult} error the extension language server error for wich we propose a solution
	 * @param {string} diagnoseId a uuid to identify the diagnose
	 */
	async proposeSolution(error:LanguageServerDiagnoseResult, diagnoseId: string){
		let response;
		switch (error){
			case LanguageServerDiagnoseResult.wrongInterpreter:
				return this.selectInterpreter(diagnoseId);
			case LanguageServerDiagnoseResult.wrongPythonVersion:
				response = await window.showErrorMessage(`The Inmanta Language Server requires at least Python 3.6, but the provided interpreter (${this.pythonPath}) is an older version.`,  "Setup assistant");
				if(response === "Setup assistant"){
					commands.executeCommand(`workbench.action.openWalkthrough`, `Inmanta.inmanta#inmanta.walkthrough`, false);
				};
				break;
			case LanguageServerDiagnoseResult.languageServerNotInstalled:
				this.proposeInstallLS(diagnoseId, LanguageServerDiagnoseResult.languageServerNotInstalled);
				break;
			case LanguageServerDiagnoseResult.wrongLanguageServer:
				this.proposeInstallLS(diagnoseId, LanguageServerDiagnoseResult.wrongLanguageServer);
				break;
			case LanguageServerDiagnoseResult.unknown:
				response = await window.showErrorMessage(`The Inmanta Language Server failed to start`, "Setup assistant");
				if(response === "Setup assistant"){
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
	async selectInterpreter(diagnoseId: string):Promise<any>{
		const response = await window.showErrorMessage(`No interpreter or invalid interpreter selected`, 'Select interpreter');
		if(response === 'Select interpreter'){
			return await commands.executeCommand('python.setInterpreter');
		}
		if(this.diagnoseId!==diagnoseId){
			//another diagnose has been run in the mean time
			return Promise.resolve();
		}
		else{
			window.showErrorMessage("The Inmanta language server could not start as no virtual environment is selected", "Setup assistant");
			if(response === "Setup assistant"){
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
		? "Wrong version of the Inmanta Language Server installed. Do you want to update? "
		: "Inmanta Language Server not installed. Install the Language server? ";
		const response = await window.showErrorMessage(msg, 'Yes', 'No');
		if(response === 'Yes'){
			await this.installLanguageServer();
			return this.startOrRestartLS(true);
		}
		if(this.diagnoseId!==diagnoseId){
			//another diagnose has been run in the mean time
			return Promise.resolve();
		} else {
			const response = await window.showErrorMessage("The Inmanta language server could not start as the language server was not installed", "Setup assistant");
			if(response === "Setup assistant"){
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
		log(`LS install requested for root folder ${this.rootFolder}`);

		this.diagnoseId = uuidv4();
		if (!this.pythonPath || !fileOrDirectoryExists(this.pythonPath)) {
			return this.selectInterpreter(this.diagnoseId);
		}
		const cmdArgs: string[] = ["-m", "pip", "install"];
		cmdArgs.push(...this.languageServerVersionToInstall());
		window.showInformationMessage("Installing Inmanta Language server. This may take a few seconds");
		const child = cp.spawnSync(this.pythonPath, cmdArgs);
		if (child.status !== 0) {
			log(`Can not start server and client`);
			const response = await window.showErrorMessage(`Inmanta Language Server install failed with code ${child.status}, ${child.stderr}`,  "Setup assistant");
			if(response === "Setup assistant"){
				return commands.executeCommand(`workbench.action.openWalkthrough`, `Inmanta.inmanta#inmanta.walkthrough`, false);
			};
			return Promise.reject("failed to install LS");
		} else{
			log("LS installed with: "+ cmdArgs.join(' '));
			window.showInformationMessage("Inmanta Language server was installed successfully");
			return Promise.resolve();
		}
	}

	/**
	 * Get options for initializing the language client.
	 * @returns {Promise<LanguageClientOptions>} A Promise that resolves to an object containing options for the language client,
	 * 		including document selector, error handler, output channel settings, and initialization options.
	 * @throws {Error} Throws an error if a file is opened instead of a folder.
	 */
	private	async getClientOptions(): Promise<LanguageClientOptions> {
		if (this.context.storageUri === undefined) {
			window.showWarningMessage("A folder should be opened instead of a file in order to use the inmanta extension.");
			throw Error("A folder should be opened instead of a file in order to use the inmanta extension.");
		}
		const folder = workspace.getWorkspaceFolder(this.rootFolder.uri);


		let compilerVenv: string | undefined;
		let repos: string | undefined;

		if (!folder) {
			// Not in a workspace
			compilerVenv = workspace.getConfiguration('inmanta').compilerVenv;
			repos = workspace.getConfiguration('inmanta').repos;
		} else {
			// In a workspace
			const multiRootConfigForResource = workspace.getConfiguration('inmanta', folder);
			compilerVenv = multiRootConfigForResource.get('compilerVenv');
			repos = multiRootConfigForResource.get('repos');
		}

		if (this.lsOutputChannel === null) {
			this.lsOutputChannel = window.createOutputChannel(`Inmanta Language Server[${this.rootFolder.uri.toString()}]`);
		}
		const clientOptions: LanguageClientOptions = {
			// Register the server for inmanta documents living under the root folder.
			documentSelector: [{ scheme: 'file', language: 'inmanta', pattern: `${this.rootFolder.uri.fsPath}/**/*`}],
			outputChannel: this.lsOutputChannel,
			revealOutputChannelOn: RevealOutputChannelOn.Info,
			errorHandler: this.errorHandler,
			initializationOptions: {
				compilerVenv: compilerVenv, //this will be ignore if inmanta-core>=6
				repos: repos,
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
		log("Start server and client");
		let clientOptions;
		try {
			clientOptions = await this.getClientOptions();
			log("Retrieved client options");
			log(`${JSON.stringify(clientOptions.initializationOptions)}`);
		} catch (err) {
			log("Error occured while retrieving client options:" + err);
			return;
		}
		try{
			if (os.platform() === "win32") {
				return this.startTcp(clientOptions);
			} else {
				return this.startPipe(clientOptions);
			}
		} catch (err) {
			log(`Could not start Language Server: ${err.message}`);
			const response = await window.showErrorMessage('Inmanta Language Server: rejected to start' + err.message, "Setup assistant");
			if(response === "Setup assistant"){
				return commands.executeCommand(`workbench.action.openWalkthrough`, `Inmanta.inmanta#inmanta.walkthrough`, false);
			};
			return Promise.reject("failed to start LS");
		}
	}

	/**
	 * Starts the TCP server and the Inmanta Language Server.
	 *
	 * @param clientOptions The options for the language client.
	 */
	private async startTcp(clientOptions: LanguageClientOptions) {
		const host = "127.0.0.1";
		// Get a random free port on 127.0.0.1
		const serverPort = await getPort({ host: host });

		const options: cp.SpawnOptionsWithoutStdio = {};
		if (process.env.INMANTA_LS_LOG_PATH) {
			log(`Language Server log file has been manually set to "${process.env.INMANTA_LS_LOG_PATH}"`);
			options.env = {
				"LOG_PATH": process.env.INMANTA_LS_LOG_PATH  // eslint-disable-line @typescript-eslint/naming-convention
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
		await new Promise<void>((resolve, reject) =>  {
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

		let serverOptions: ServerOptions = function () {
			let socket = net.connect({ port: serverPort, host: host});
			const streamInfo = {
				reader: socket,
				writer: socket
			};
			return Promise.resolve(streamInfo);
		};

		this.client = new LanguageClient('inmanta-ls', 'Inmanta Language Server', serverOptions, clientOptions);
		// Create the language client and start the client.

		log(`Starting Language Client with options: ${JSON.stringify({
			serverOptions: serverOptions,
			clientOptions: clientOptions
		}, null, 2)}`);

		await this.client.start();
	}

	/**
	 * Starts the Inmanta Language Server by creating a new LanguageClient and starting it with the given clientOptions.
	 *
	 * @param {LanguageClientOptions} clientOptions The options for the LanguageClient.
	 */
	async startPipe(clientOptions: LanguageClientOptions) {
		log(`Python path is ${this.pythonPath}`);

		const serverOptions: ServerOptions = {
			command: this.pythonPath,
			args: ["-m", "inmantals.pipeserver"],
			options: {
				env: {}
			}
		};

		if (process.env.INMANTA_LS_LOG_PATH) {
			log(`Language Server log file has been manually set to "${process.env.INMANTA_LS_LOG_PATH}"`);
			serverOptions.options.env["LOG_PATH"] = process.env.INMANTA_LS_LOG_PATH;
		}

		// Create the language client and start the client.
		log(`serv options ${JSON.stringify(serverOptions)}`);
		logAllClientOptions(clientOptions);
		this.client = new LanguageClient('inmanta-ls', 'Inmanta Language Server', serverOptions, clientOptions);
		log("Waiting for language Client to start");
		log(`Starting Language Client with options: ${JSON.stringify({
			serverOptions: serverOptions,
			clientOptions: clientOptions
		}, null, 2)}`);
		await this.client.start();
	}

	/**
	 * Starts or restarts the language server.
	 * @param {boolean} start Whether to start the server or restart it.
	 * @returns {Promise<void>}
	 */
	async startOrRestartLS(start: boolean = false, canStart?: LanguageServerDiagnoseResult): Promise<void>{
		this.diagnoseId = uuidv4();
		if (canStart === undefined) {
			canStart = await this.canServerStart();
		}
		if (canStart !== LanguageServerDiagnoseResult.ok){
			return this.proposeSolution(canStart, this.diagnoseId);
		}

		if(start){
			log("starting Language Server");
		} else {
			log("restarting Language Server");
		}
		const enable: boolean = workspace.getConfiguration('inmanta').ls.enabled;
		await this.stopServerAndClient();
		if (enable) {
			await this.startServerAndClient();
			window.showInformationMessage(`The Language server has been enabled for folder ${this.rootFolder.name}`);
		}

	}

	/**
	 * Stops the language server and its client.
	 */
	async stopServerAndClient() {
		log("Stopping server and client...");
		await this.mutex.runExclusive(async () => {
			if (this.client) {
				if(this.client.needsStop()){
					await this.client.stop();
				}
				this.client = undefined;
			}
			if(this.serverProcess){
				if(!this.serverProcess.exitCode){
					this.serverProcess.kill();
				}
				this.serverProcess = undefined;
			}
		});
	}

	cleanOutputChannel() {
		this.lsOutputChannel.dispose();
	}
}

function logAllClientOptions(clientOptions){
	log(JSON.stringify(clientOptions));
}


