'use strict';

import * as net from 'net';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as path from 'path';
import * as os from 'os';
import getPort = require('get-port');


import { workspace, ExtensionContext, window, Uri, commands, OutputChannel, extensions } from 'vscode';
import { RevealOutputChannelOn, LanguageClientOptions, ErrorHandler, Message, ErrorAction, CloseAction, ErrorHandlerResult, CloseHandlerResult } from 'vscode-languageclient';
import { LanguageClient, ServerOptions } from 'vscode-languageclient/node';
import { PythonExtension, PYTHONEXTENSIONID } from './python_extension';
import { Mutex } from 'async-mutex';

function fileOrDirectoryExists(filePath: string): boolean {
	try {
	  fs.accessSync(filePath);
	  return true;
	} catch (error) {
	  return false;
	}
  }

export function log(message: string) {
	console.log(`[${new Date().toUTCString()}][vscode-inmanta] ${message}`);
}

// Make sure starting and stopping the server is protected by a mutex
// To avoid a potential race condition when changing the active venv leading to multiple running language servers
const mutex = new Mutex();
let client: LanguageClient;
let serverProcess: cp.ChildProcess;

export async function activate(context: ExtensionContext) {
	//use Python extension
	const pythonExtension = extensions.getExtension(PYTHONEXTENSIONID);
	if (pythonExtension === undefined) {
		throw Error("Python extension not found");
	}
	log("Activate Python extension");
	await pythonExtension.activate();
	const pythonExtentionApi = new PythonExtension(pythonExtension.exports, startOrRestartLS);

	let lsOutputChannel = null;

	async function startServerAndClient() {
		/**
		 * Should always run under `mutex` lock.
		 */
		if(!pythonExtentionApi.pythonPath || !fileOrDirectoryExists(pythonExtentionApi.pythonPath)){
			const response = await window.showErrorMessage(`No interpreter or invalid interpreter selected`, 'Select interpreter');
			if(response === 'Select interpreter'){
				return await commands.executeCommand('python.setInterpreter');
			}
		}
		log("Start server and client");
		let clientOptions;
		try {
			clientOptions = await getClientOptions();
			log("Retrieved client options");
		} catch (err) {
			return;
		}
		try{
			if (os.platform() === "win32") {
				await startTcp(clientOptions);
			} else {
				await startPipe(clientOptions);
			}
		} catch (err) {
			log(`Could not start Language Server: ${err.message}`);
			window.showErrorMessage('Inmanta Language Server: rejected to start' + err.message);
		}
	}

	async function getClientOptions(): Promise<LanguageClientOptions> {
		if (context.storageUri === undefined) {
			window.showWarningMessage("A folder should be opened instead of a file in order to use the inmanta extension.");
			throw Error("A folder should be opened instead of a file in order to use the inmanta extension.");
		}
		const editor = window.activeTextEditor;
		const resource = editor.document.uri;
		const folder = workspace.getWorkspaceFolder(resource);


		let compilerVenv: string | undefined;
		let repos: string | undefined;
		try{
			if (!folder) {
				// Not in a workspace
				compilerVenv = workspace.getConfiguration('inmanta').compilerVenv;
				repos = workspace.getConfiguration('inmanta').repos;

			} else {
				// In a workspace
				const multiRootConfigForResource = workspace.getConfiguration('inmanta', resource);
				compilerVenv = multiRootConfigForResource.get('compilerVenv');
				repos = multiRootConfigForResource.get('repos');
			}
		} catch (err) {
			log(`Could not start Language Server: ${err.message}`);
			window.showErrorMessage('Inmanta Language Server: rejected to start' + err.message);
		}

		const errorhandler = new LsErrorHandler();

		const clientOptions: LanguageClientOptions = {
			// Register the server for inmanta documents
			documentSelector: [{ scheme: 'file', language: 'inmanta' }],
			errorHandler: errorhandler,
			revealOutputChannelOn: RevealOutputChannelOn.Info,
			initializationOptions: {
				compilerVenv: compilerVenv, //this will be ignore if inmanta-core>=6
				repos: repos,
			}
		};
		return clientOptions;
	}

	async function startTcp(clientOptions: LanguageClientOptions) {
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

		serverProcess = cp.spawn(pythonExtentionApi.pythonPath, ["-m", "inmantals.tcpserver", serverPort.toString()], options);
		let started = false;
		serverProcess.stdout.on('data', (data) => {
			lsOutputChannel.appendLine(`stdout: ${data}`);
			if (data.includes("starting")) {
				started = true;
			}
		});

		if (lsOutputChannel === null) {
			lsOutputChannel = window.createOutputChannel("Inmanta Language Server");
		}
		serverProcess.stderr.on('data', (data) => {
			lsOutputChannel.appendLine(`stderr: ${data}`);
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

		client = new LanguageClient('inmanta-ls', 'Inmanta Language Server', serverOptions, clientOptions);
		// Create the language client and start the client.
		await client.start();
	}

	function installLanguageServer(pythonPath: string, startServer?: boolean): void {
		const args = ["-m", "pip", "install"];
		if (process.env.INMANTA_LS_PATH) {
			args.push("-e", process.env.INMANTA_LS_PATH);
			log(`Installing Language Server from local source "${process.env.INMANTA_LS_PATH}"`);
		} else {
			args.push("inmantals");
		}
		const child = cp.spawnSync(pythonPath, args);
		if (child.status !== 0) {
			log(`Can not start server and client`);
			window.showErrorMessage(`Inmanta Language Server install failed with code ${child.status}, ${child.stderr}`);
		} else if (startServer) {
			log(`Starting server and client`);
			startOrRestartLS(true);
		}
	}

	class LsErrorHandler implements ErrorHandler {

		_child: cp.ChildProcess;

		notInstalled() {
			window.showErrorMessage(`Inmanta Language Server not installed, run "${pythonExtentionApi.pythonPath} -m pip install inmantals" ?`, 'Yes', 'No').then(
				(answer) => {
					if (answer === 'Yes') {
						installLanguageServer(pythonExtentionApi.pythonPath, true);
					}
				}
			);
		}

		async diagnose() {
			if (this._child !== undefined) {
				return;
			}

			const script = "import sys\n" +
				"if sys.version_info[0] != 3 or sys.version_info[1] < 6:\n" +
				"  exit(4)\n" +
				"try:\n" +
				"  import inmantals.pipeserver\n" +
				"  sys.exit(0)\n" +
				"except:\n" +
				"  sys.exit(3)";

			let spawnResult = cp.spawnSync(pythonExtentionApi.pythonPath, ["-c", script]);
			if (spawnResult.status === 4) {
				window.showErrorMessage(`Inmanta Language Server requires at least python 3.6, the python binary provided at ${pythonExtentionApi.pythonPath} is an older version`);
			} else if (spawnResult.status === 3) {
				this.notInstalled();
			} else {
				const data = this._child.stdout.read();
				window.showErrorMessage("Inmanta Language Server could not start, could not determined cause of failure" + data);
			}
		}

		error(error: Error, message: Message | undefined, count: number | undefined): ErrorHandlerResult {
			this.diagnose();
			return {action: ErrorAction.Shutdown};
		}

		closed(): CloseHandlerResult{
			this.diagnose();
			return {action: CloseAction.DoNotRestart};
		}

	}

	async function startPipe(clientOptions: LanguageClientOptions) {
		log(`Python path is ${pythonExtentionApi.pythonPath}`);

		const serverOptions: ServerOptions = {
			command: pythonExtentionApi.pythonPath,
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
		client = new LanguageClient('inmanta-ls', 'Inmanta Language Server', serverOptions, clientOptions);
		log(`Starting Language Client with options: ${JSON.stringify({
			serverOptions: serverOptions,
			clientOptions: clientOptions
		}, null, 2)}`);
		await client.start();
	}

	function registerExportCommand() {
		const commandId = 'inmanta.exportToServer';

		const commandHandler = (openedFileObj: object) => {
			const pathOpenedFile: string = String(openedFileObj);
			const cwdCommand: string = path.dirname(Uri.parse(pathOpenedFile).fsPath);
			const child = cp.spawn(pythonExtentionApi.pythonPath, ["-m", "inmanta.app", "-vv", "export"], {cwd: `${cwdCommand}`});

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

		context.subscriptions.push(commands.registerCommand(commandId, commandHandler));
    }

	async function startOrRestartLS(start: boolean = false) {
		await mutex.runExclusive(async () => {
			if(start){
				log("starting Language Server");
			} else {
				log("restarting Language Server");
			}
			const enable: boolean = workspace.getConfiguration('inmanta').ls.enabled;
			await stopServerAndClient();
			if (enable) {
				startServerAndClient();
			}
		});
	}

	const enable: boolean = workspace.getConfiguration('inmanta').ls.enabled;
	if (enable) {
		await startOrRestartLS(true);
	}

	context.subscriptions.push(workspace.onDidChangeConfiguration(async e => {
		if (e.affectsConfiguration('inmanta')) {
			await startOrRestartLS();
		}
	}));

	let exportToServerChannel: OutputChannel = null;
	registerExportCommand();
}

async function stopServerAndClient() {
	/**
	 * Should always execute under the `mutex` lock.
	 */
	if (client) {
		if(client.needsStop()){
			await client.stop();
		}
		client = undefined;
	}
	if(serverProcess){
		if(!serverProcess.exitCode){
			serverProcess.kill();
		}
		serverProcess = undefined;
	}
}

export async function deactivate(){
	await mutex.runExclusive(async () => {
		return stopServerAndClient();
	});
}
