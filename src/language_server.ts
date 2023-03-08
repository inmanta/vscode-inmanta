'use strict';

import * as net from 'net';
import * as cp from 'child_process';
import * as os from 'os';
import getPort from 'get-port';

import { commands, ExtensionContext, OutputChannel, window, workspace} from 'vscode';
import { RevealOutputChannelOn, LanguageClientOptions} from 'vscode-languageclient';
import { LanguageClient, ServerOptions } from 'vscode-languageclient/node';
import { Mutex } from 'async-mutex';
import { fileOrDirectoryExists, log } from './utils';
import { LsErrorHandler } from './extension';

enum LanguageServerDiagnoseResult {
	wrongInterpreter,
	wrongPythonVersion,
	languageServerNotInstalled,
	unknown,
	ok,
  }

export class LanguageServer {
	mutex = new Mutex();
	client: LanguageClient;
	serverProcess: cp.ChildProcess;
	context: ExtensionContext;
	pythonPath: string;
	errorHandler = new LsErrorHandler();
	lsOutputChannel:OutputChannel = null;

	constructor(context: ExtensionContext, pythonPath: string, errorHandler: LsErrorHandler) {
		/**
		 * Initialize a LanguageServer instance with the given context and PythonExtension instance.
         *
         * @param {ExtensionContext} context the extension context.
         * @param {Extension<any>} pythonExtension the Python extension.
         */
		this.context = context;
		this.pythonPath = pythonPath;
		this.errorHandler = errorHandler;
	}

	async canServerStart():Promise<LanguageServerDiagnoseResult>{
		/**
         * Check if the server can start.
         *
         * @returns {Promise<LanguageServerDiagnoseResult>} The diagnose result
         */
		if (!this.pythonPath || !fileOrDirectoryExists(this.pythonPath)) {
			return LanguageServerDiagnoseResult.wrongInterpreter;
		}
		const script = "import sys\n" +
			"if sys.version_info[0] != 3 or sys.version_info[1] < 6:\n" +
			"  exit(4)\n" +
			"try:\n" +
			"  import inmantals\n" +
			"  sys.exit(0)\n" +
			"except ModuleNotFoundError:\n" +
			"  sys.exit(3)";
			"except ModuleNotFoundError:\n" +
			"  print(e)\n" +
			"  sys.exit(5)";

		let spawnResult = cp.spawnSync(this.pythonPath, ["-c", script]);
		const stdout = spawnResult.stdout.toString();
		if (spawnResult.status === 4) {
			return LanguageServerDiagnoseResult.wrongPythonVersion;
		} else if (spawnResult.status === 3) {
			return LanguageServerDiagnoseResult.languageServerNotInstalled;
		} else if (spawnResult.status !== 0) {
			log("can not start server due to: "+stdout);
			return LanguageServerDiagnoseResult.unknown;
		}
		else{
			return LanguageServerDiagnoseResult.ok;
		}
	}

	async proposeSolution(error:LanguageServerDiagnoseResult){
		/**
		 * Propose a solution according to the given error.
         *
         * @param {LanguageServerDiagnoseResult} error the extension language server error for wich we propose a solution
         */
		switch (error){
			case LanguageServerDiagnoseResult.wrongInterpreter:
				await this.selectInterpreter();
				break;
			case LanguageServerDiagnoseResult.wrongPythonVersion:
				window.showErrorMessage(`The Inmanta Language Server requires at least Python 3.6, but the provided interpreter (${this.pythonPath}) is an older version.`);
				break;
			case LanguageServerDiagnoseResult.languageServerNotInstalled:
				this.proposeInstallLS();
				break;
			case LanguageServerDiagnoseResult.unknown:
				window.showErrorMessage(`The Inmanta Language Server failed to start`);
				break;
		}
	}

	async selectInterpreter(){
		/**
		* Prompt the user to select a Python interpreter.
		* @returns {Promise<any>} A Promise that resolves to the result of startOrRestartLS() after the interpreter is selected.
		*    If the user cancels the selection, a Promise rejection with the message "No Interpreter Selected" is returned.
		*/
		const response = await window.showErrorMessage(`No interpreter or invalid interpreter selected`, 'Select interpreter');
		if(response === 'Select interpreter'){
			return await commands.executeCommand('python.setInterpreter').then(()=>{
				log(`Starting server and client`);
				return this.startOrRestartLS(true);
			});

		} else{
			window.showErrorMessage("The Inmanta language server could not start as no virtual environment is selected");
			return Promise.reject("No Interpreter Selected");
		}
	}

	async proposeInstallLS() {
		/**
		 * Propose to install the Language server.
		 * If the Python interpreter is not set or invalid, prompts the user to select a valid interpreter.
		 * @returns {Promise<any>} - A Promise that resolves to the result of `installLanguageServer()` after the server is installed.
		 * If the user declines to install the server, returns a Promise that rejects with an error message.
		 */
		if (!this.pythonPath || !fileOrDirectoryExists(this.pythonPath)) {
			await this.selectInterpreter();
		}
		const response = await window.showErrorMessage(`Inmanta Language Server not installed, run "${this.pythonPath} -m pip install inmantals" ?`, 'Yes', 'No');
		if(response === 'Yes'){
			this.installLanguageServer(true);
		} else {
			window.showErrorMessage("The Inmanta language server could not start as the language server was not installed");
			return Promise.reject("Inmanta Language Server was not installed");
		}

	}

	async installLanguageServer(startServer?: boolean): Promise<void> {
		/**
		 * Install the Inmanta Language Server and start it if specified.
		 * @param {boolean} [startServer=true] Optional boolean to indicate whether to start the language server after installation. Default is true.
		 * @returns {Promise<void>}
		 */
		if (!this.pythonPath || !fileOrDirectoryExists(this.pythonPath)) {
			await this.selectInterpreter();
		}
		const args = ["-m", "pip", "install"];
		if (process.env.INMANTA_LS_PATH) {
			args.push("-e", process.env.INMANTA_LS_PATH);
			log(`Installing Language Server from local source "${process.env.INMANTA_LS_PATH}"`);
		} else {
			args.push("inmantals");
		}
		const child = cp.spawnSync(this.pythonPath, args);
		if (child.status !== 0) {
			log(`Can not start server and client`);
			window.showErrorMessage(`Inmanta Language Server install failed with code ${child.status}, ${child.stderr}`);
		} else{
			window.showInformationMessage("Inmanta Language server was installed successfully");
		}

		if (startServer) {
			log(`Starting server and client`);
			this.startOrRestartLS(true);
		}
	}

	private	async getClientOptions(): Promise<LanguageClientOptions> {
		/**
		 * Get options for initializing the language client.
		 * @returns {Promise<LanguageClientOptions>} A Promise that resolves to an object containing options for the language client, including document selector, error handler, output channel settings, and initialization options.
		 * @throws {Error} Throws an error if a file is opened instead of a folder.
		 */
		let compilerVenv: string = workspace.getConfiguration('inmanta').compilerVenv;
		let repos: string = workspace.getConfiguration('inmanta').repos;
		if (this.context.storageUri === undefined) {
			window.showWarningMessage("A folder should be opened instead of a file in order to use the inmanta extension.");
			throw Error("A folder should be opened instead of a file in order to use the inmanta extension.");
		}

		const clientOptions: LanguageClientOptions = {
			// Register the server for inmanta documents
			documentSelector: [{ scheme: 'file', language: 'inmanta' }],
			errorHandler: this.errorHandler,
			revealOutputChannelOn: RevealOutputChannelOn.Info,
			initializationOptions: {
				compilerVenv: compilerVenv, //this will be ignore if inmanta-core>=6
				repos: repos,
			}
		};
		return clientOptions;
	}

	private async startServerAndClient(): Promise<void> {
		/**
		 * Starts the Inmanta Language Server and client.
		 * This function should always run under the `mutex` lock.
		 * @returns {Promise<void>} A Promise that resolves when the server and client are started successfully.
		 */
		log("Start server and client");
		let clientOptions;
		try {
			clientOptions = await this.getClientOptions();
			log("Retrieved client options");
		} catch (err) {
			return;
		}
		try{
			if (os.platform() === "win32") {
				await this.startTcp(clientOptions);
			} else {
				await this.startPipe(clientOptions);
			}
		} catch (err) {
			log(`Could not start Language Server: ${err.message}`);
			window.showErrorMessage('Inmanta Language Server: rejected to start' + err.message);
		}
	}

	private async startTcp(clientOptions: LanguageClientOptions) {
		/**
		 * Starts the TCP server and the Inmanta Language Server.
		 *
		 * @param clientOptions The options for the language client.
		 */
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

		if (this.lsOutputChannel === null) {
			this.lsOutputChannel = window.createOutputChannel("Inmanta Language Server");
		}
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
		await this.client.start();
	}

	async startPipe(clientOptions: LanguageClientOptions) {
		/**
		 * Starts the Inmanta Language Server by creating a new LanguageClient and starting it with the given clientOptions.
		 *
		 * @param {LanguageClientOptions} clientOptions The options for the LanguageClient.
		 */
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
		this.client = new LanguageClient('inmanta-ls', 'Inmanta Language Server', serverOptions, clientOptions);
		log(`Starting Language Client with options: ${JSON.stringify({
			serverOptions: serverOptions,
			clientOptions: clientOptions
		}, null, 2)}`);
		await this.client.start();
	}

	async startOrRestartLS(start: boolean = false){
		/**
		 * Starts or restarts the language server.
		 * @param {boolean} start Whether to start the server or restart it.
		 */
		const canStart = await this.canServerStart();
		if (canStart !== LanguageServerDiagnoseResult.ok){
			await this.proposeSolution(canStart);
			return;
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
		}

	}

	private async stopServerAndClient() {
		/**
		 * Stops the language server and its client.
		 */
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
}
