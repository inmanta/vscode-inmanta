'use strict';

import * as net from 'net';

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as getPort from 'get-port';

import { workspace, ExtensionContext, Disposable, window, Uri, commands, OutputChannel } from 'vscode';
import { RevealOutputChannelOn, LanguageClient, LanguageClientOptions, ServerOptions, Executable, ErrorHandler, Message, ErrorAction, CloseAction } from 'vscode-languageclient';


export async function activate(context: ExtensionContext) {
	let lsOutputChannel = null;

	async function startServerAndClient() {
		const clientOptions = getClientOptions();
		if (os.platform() === "win32") {
			return await startTcp(clientOptions);
		} else {
			return startPipe(clientOptions);
		}
	}

	function getClientOptions(): LanguageClientOptions {
		const errorhandler = new LsErrorHandler();

		// Options to control the language client
		const compilerVenv: string = workspace.getConfiguration('inmanta').compilerVenv || Uri.joinPath(context.storageUri, ".env-ls-compiler").fsPath;
		const clientOptions: LanguageClientOptions = {
			// Register the server for inmanta documents
			documentSelector: [{ scheme: 'file', language: 'inmanta' }],
			errorHandler: errorhandler,
			revealOutputChannelOn: RevealOutputChannelOn.Info,
			initializationOptions: {
				compilerVenv: compilerVenv
			}
		};
		return clientOptions;
	}
	
	async function startTcp(clientOptions: LanguageClientOptions) {
		const host = "127.0.0.1";
		const pp: string = createVenvIfNotExists();
		// Get a random free port on 127.0.0.1
		const serverPort = await getPort({ host: host });
		
		const serverProcess = cp.spawn(pp, ["-m", "inmantals.tcpserver", serverPort.toString()]);
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
		await new Promise((resolve, reject) =>  {
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
		
		const serverDisposable = new Disposable(function disposeOfServerProcess(){
			serverProcess.kill()
		})
		let serverOptions: ServerOptions = function () {
			let client = net.connect({ port: serverPort, host: host});
			const streamInfo = {
				reader: client,
				writer: client
			};
			return Promise.resolve(streamInfo);
		}

		const lc = new LanguageClient('inmanta-ls', 'Inmanta Language Server', serverOptions, clientOptions);
		// Create the language client and start the client.
		const clientDisposable = lc.start();
		lc.onReady().catch((clientOptions.errorHandler as LsErrorHandler).rejected);

		// Push the disposable to the context's subscriptions so that the
		// client can be deactivated on extension deactivation
		const commonDisposable = new Disposable(function() {
			clientDisposable.dispose();
			serverDisposable.dispose();
		})
		context.subscriptions.push(commonDisposable);
		
		return commonDisposable;
	}

	function installLanguageServer(pythonPath: string, startServer?: boolean): void {
		const child = cp.spawnSync(pythonPath, ["-m", "pip", "install", "inmantals"]);
		if (child.status !== 0) {
			window.showErrorMessage(`Inmanta Language Server install failed with code ${child.status}, ${child.stderr}`);
		} else if (startServer) {
			startServerAndClient();
		}
	}

	class LsErrorHandler implements ErrorHandler {

		_child: cp.ChildProcess;

		notInstalled() {
			const pp: string = workspace.getConfiguration('inmanta').pythonPath;

			window.showErrorMessage(`Inmanta Language Server not installed, run "${pp} -m pip install inmantals" ?`, 'Yes', 'No').then(
				(answer) => {
					if (answer === 'Yes') {
						installLanguageServer(pp, true);
					}
				}
			);
		}

		diagnose() {
			if (this._child !== undefined) {
				return;
			}

			const pp: string = createVenvIfNotExists();

			if (!fs.existsSync(pp)) {
				window.showErrorMessage("No python36 interpreter found at `" + pp + "`. Please update the config setting `inmanta.pythonPath` to point to a valid python interperter.");
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

			this._child = cp.spawn(pp, ["-c", script]);

			this._child.on('close', (code) => {
				if (code === 4) {
					window.showErrorMessage(`Inmanta Language Server requires at least python 3.6, the python binary provided at ${pp} is an older version`);
				} else if (code === 3) {
					this.notInstalled();
				} else {
					const data = this._child.stdout.read();
					window.showErrorMessage("Inmanta Language Server could not start, could not determined cause of failure" + data);
				}
				this._child = undefined;
			});

		}

		error(error: Error, message: Message, count: number): ErrorAction {
			this.diagnose();
			return ErrorAction.Shutdown;
		}

		closed(): CloseAction {
			this.diagnose();
			return CloseAction.DoNotRestart;
		}

		rejected(reason) {
			window.showErrorMessage('Inmanta Language Server: rejected to start' + reason);
		}

	}

	function startPipe(clientOptions: LanguageClientOptions) {
		const pp: string = createVenvIfNotExists();

		const serverOptions: Executable = {
			command: pp,
			args: ["-m", "inmantals.pipeserver"],
		};

		const lc = new LanguageClient('inmanta-ls', 'Inmanta Language Server', serverOptions, clientOptions);
		lc.onReady().catch((clientOptions.errorHandler as LsErrorHandler).rejected);

		// Create the language client and start the client.
		const disposable = lc.start();

		// Push the disposable to the context's subscriptions so that the
		// client can be deactivated on extension deactivation
		context.subscriptions.push(disposable);
		return disposable;
	}

	const enable: boolean = workspace.getConfiguration('inmanta').ls.enabled;

	function getDefaultVenvPath() {
		if (os.platform() === "win32") {
			return Uri.joinPath(context.globalStorageUri, ".env", "Scripts", "python.exe").fsPath;
		}
		return Uri.joinPath(context.globalStorageUri, ".env", "bin", "python").fsPath;
	}

	function createVenvIfNotExists() {
		const pp: string = workspace.getConfiguration('inmanta').pythonPath;
		if (pp && fs.existsSync(pp)) {
			return pp;
		} else {
			window.showInformationMessage(`No Python3 interpreter found at "${pp}". Falling back to default virtual environment`);
		}
		const venvBaseDir = Uri.joinPath(context.globalStorageUri, ".env").fsPath;
		const venvPath = getDefaultVenvPath();

		if (!fs.existsSync(venvBaseDir)) {
			const venvProcess = cp.spawnSync("python3", ["-m", "venv", venvBaseDir]);
			if (venvProcess.status !== 0) {
				window.showErrorMessage(`Virtual env creation at ${venvBaseDir} failed with code ${venvProcess.status}, ${venvProcess.stderr}`);
			}
			installLanguageServer(venvPath);
		}
		workspace.getConfiguration("inmanta").update("pythonPath", venvPath, true);
		return venvPath;
	}

	function registerExportCommand() {
		const commandId = 'inmanta.exportToServer';

		const commandHandler = (openedFileObj: object) => {
			const pathOpenedFile: string = String(openedFileObj);
			const cwdCommand: string = path.dirname(Uri.parse(pathOpenedFile).fsPath);
			const pythonPath: string = workspace.getConfiguration('inmanta').pythonPath;
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

		context.subscriptions.push(commands.registerCommand(commandId, commandHandler));
    }

	let running: Disposable = undefined;

	if (enable) {
		running = await startServerAndClient();
	}

	function stopIfRunning() {
		if (running !== undefined) {
			running.dispose();
			running = undefined;
		}

	}

	context.subscriptions.push(workspace.onDidChangeConfiguration(async e => {
		if (e.affectsConfiguration('inmanta')) {
			const enable: boolean = workspace.getConfiguration('inmanta').ls.enabled;

			stopIfRunning();

			if (enable) {
				running = await startServerAndClient();
			}
		}
	}));

	let exportToServerChannel: OutputChannel = null;
	registerExportCommand();
}
