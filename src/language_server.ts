'use strict';

import * as net from 'net';
import * as cp from 'child_process';
import * as os from 'os';
import getPort from 'get-port';

import { commands, Extension, ExtensionContext, OutputChannel, window, workspace} from 'vscode';
import { RevealOutputChannelOn, LanguageClientOptions, ErrorHandler, Message, ErrorAction, CloseAction, ErrorHandlerResult, CloseHandlerResult } from 'vscode-languageclient';
import { LanguageClient, ServerOptions } from 'vscode-languageclient/node';
import { Mutex } from 'async-mutex';
import { PythonExtension } from './python_extension';
import { fileOrDirectoryExists, log } from './utils';

/**
 * Enum representing possible errors that can occur when starting the Inmanta language server.
 */
enum LanguageServerDiagnoseResult {
	wrongInterpreter,
	wrongPythonVersion,
	languageServerNotInstalled,
	unknown,
	ok,
  }

/**
 * Language server class responsible for starting and managing the Inmanta language server process.
 */
export class LanguageServer {
	mutex = new Mutex();
	client: LanguageClient;
	serverProcess: cp.ChildProcess;
	context: ExtensionContext;
	pythonExtentionApi: PythonExtension;
	errorhandler = new LsErrorHandler();
	lsOutputChannel:OutputChannel = null;

	/**
	 * @param context - The extension context
	 * @param pythonExtension - The Python extension used to start the language server
	 */
	constructor(context: ExtensionContext, pythonExtension: Extension<any>) {
		this.context = context;
		this.pythonExtentionApi = new PythonExtension(pythonExtension.exports, this.startOrRestartLS.bind(this));
	}

	/**
	 * Method used to check if the language server can start or if an error occurred.
	 * @returns A LanguageServerError if an error occurred or undefined if the server can start
	 */
	async canServerStart():Promise<LanguageServerDiagnoseResult>{
		if (!this.pythonExtentionApi.pythonPath || !fileOrDirectoryExists(this.pythonExtentionApi.pythonPath)) {
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

		let spawnResult = cp.spawnSync(this.pythonExtentionApi.pythonPath, ["-c", script]);
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

	/**
	 * Method used to propose a solution for a given error that occurs when starting the language server.
	 * @param error - The error that occurred when starting the language server
	 */
	async proposeSolution(error:LanguageServerDiagnoseResult){
		switch (error){
			case LanguageServerDiagnoseResult.wrongInterpreter:
				await this.selectInterpreter();
				break;
			case LanguageServerDiagnoseResult.wrongPythonVersion:
				window.showErrorMessage(`The Inmanta Language Server requires at least Python 3.6, but the provided interpreter (${this.pythonExtentionApi.pythonPath}) is an older version.`);
				break;
			case LanguageServerDiagnoseResult.languageServerNotInstalled:
				this.proposeInstallLS();
				break;
			case LanguageServerDiagnoseResult.unknown:
				window.showErrorMessage(`The Inmanta Language Server failed to start`);
				break;
		}
	}

	/**
	 * Method used to select the interpreter when none is available or an invalid interpreter is selected.
	 */
	async selectInterpreter(){
		const response = await window.showErrorMessage(`No interpreter or invalid interpreter selected`, 'Select interpreter');
		if(response === 'Select interpreter'){
			return await commands.executeCommand('python.setInterpreter').then(()=>{
				log(`Starting server and client`);
				this.startOrRestartLS(true);
			});

		} else{
			window.showErrorMessage("The Inmanta language server could not start as no virtual environment is selected");
			return Promise.reject("No Interpreter Selected");
		}
	}

	/**
	 * Method used to propose the user to install the Inmanta Language Server
	 */
	async proposeInstallLS() {
		if (!this.pythonExtentionApi.pythonPath || !fileOrDirectoryExists(this.pythonExtentionApi.pythonPath)) {
			await this.selectInterpreter();
		}
		const response = await window.showErrorMessage(`Inmanta Language Server not installed, run "${this.pythonExtentionApi.pythonPath} -m pip install inmantals" ?`, 'Yes', 'No');
		if(response === 'Yes'){
			this.installLanguageServer(true);
		} else {
			window.showErrorMessage("The Inmanta language server could not start as the language server was not installed");
			return Promise.reject("Inmanta Language Server was not installed");
		}

	}

	async installLanguageServer(startServer?: boolean): Promise<void> {
		if (!this.pythonExtentionApi.pythonPath || !fileOrDirectoryExists(this.pythonExtentionApi.pythonPath)) {
			await this.selectInterpreter();
		}
		const args = ["-m", "pip", "install"];
		if (process.env.INMANTA_LS_PATH) {
			args.push("-e", process.env.INMANTA_LS_PATH);
			log(`Installing Language Server from local source "${process.env.INMANTA_LS_PATH}"`);
		} else {
			args.push("inmantals");
		}
		const child = cp.spawnSync(this.pythonExtentionApi.pythonPath, args);
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
		let compilerVenv: string = workspace.getConfiguration('inmanta').compilerVenv;
		let repos: string = workspace.getConfiguration('inmanta').repos;
		if (this.context.storageUri === undefined) {
			window.showWarningMessage("A folder should be opened instead of a file in order to use the inmanta extension.");
			throw Error("A folder should be opened instead of a file in order to use the inmanta extension.");
		}

		const clientOptions: LanguageClientOptions = {
			// Register the server for inmanta documents
			documentSelector: [{ scheme: 'file', language: 'inmanta' }],
			errorHandler: this.errorhandler,
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
		 * Should always run under `mutex` lock.
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

		this.serverProcess = cp.spawn(this.pythonExtentionApi.pythonPath, ["-m", "inmantals.tcpserver", serverPort.toString()], options);
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
					reject();
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
		log(`Python path is ${this.pythonExtentionApi.pythonPath}`);

		const serverOptions: ServerOptions = {
			command: this.pythonExtentionApi.pythonPath,
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

	async startOrRestartLS(start: boolean = false): Promise<void> {
		const canStart = await this.canServerStart();
		if (canStart !== LanguageServerDiagnoseResult.ok){
			await this.proposeSolution(canStart);
			return;
		}
		await this.mutex.runExclusive(async () => {
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
		});
	}

	private async stopServerAndClient(): Promise<void> {
		/**
		 * Should always execute under the `mutex` lock.
		 */
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
	}
}

class LsErrorHandler implements ErrorHandler{
	error(error: Error, message: Message | undefined, count: number | undefined): ErrorHandlerResult {;
		return {action: ErrorAction.Shutdown};
	}

	closed(): CloseHandlerResult{
		return {action: CloseAction.DoNotRestart};
	}

}
