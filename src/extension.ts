'use strict';

import * as net from 'net';

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { workspace, ExtensionContext, Disposable, window, Uri, commands, OutputChannel } from 'vscode';
import { RevealOutputChannelOn, LanguageClient, LanguageClientOptions, ServerOptions, TransportKind, Executable, ErrorHandler, Message, ErrorAction, CloseAction } from 'vscode-languageclient';

export function activate(context: ExtensionContext) {

	//let serverOptions: ServerOptions = {command:'python3', args:['-m', 'inmanta-lsp']};

	function startTCP() {
		// have to start server by hand, debugging only
		const serverOptions: ServerOptions = function () {
			return new Promise((resolve, reject) => {
				const client = new net.Socket();
				client.connect(5432, "127.0.0.1", function () {
					resolve({
						reader: client,
						writer: client
					});
				});
			});
		};

		// Options to control the language client
		const clientOptions: LanguageClientOptions = {
			// Register the server for inmanta documents
			documentSelector: [{ scheme: 'file', language: 'inmanta' }]
		};

		const lc = new LanguageClient('inmanta-ls', 'Inmanta Language Server', serverOptions, clientOptions);
		// Create the language client and start the client.
		const disposable = lc.start();

		// Push the disposable to the context's subscriptions so that the
		// client can be deactivated on extension deactivation
		context.subscriptions.push(disposable);
		return disposable;
	}

	function installLanguageServer(pythonPath: string, startServer?: boolean): void {
		const child = cp.spawnSync(pythonPath, ["-m", "pip", "install", "inmantals"]);
		if (child.status !== 0) {
			window.showErrorMessage(`Inmanta Language Server install failed with code ${child.status}, ${child.stderr}`);
		} else if (startServer) {
			startPipe();
		}
	}

	class LsErrorHandler implements ErrorHandler {

		_serverOptions: Executable;
		_child: cp.ChildProcess;

		constructor(serverOptions: Executable) {
			this._serverOptions = serverOptions;
		}

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

			this._child = cp.spawn(this._serverOptions.command, ["-c", script]);

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

	function startPipe() {
		const pp: string = createVenvIfNotExists();

		const serverOptions: Executable = {
			command: pp,
			args: ["-m", "inmantals.pipeserver"],
		};

		const errorhandler = new LsErrorHandler(serverOptions);

		const compilerVenv: string = workspace.getConfiguration('inmanta').compilerVenv || Uri.joinPath(context.storageUri, ".env-ls-compiler").fsPath;
		workspace.getConfiguration('inmanta').update('compilerVenv', compilerVenv, true);

		const clientOptions: LanguageClientOptions = {
			documentSelector: [{ scheme: 'file', language: 'inmanta' }],
			errorHandler: errorhandler,
			revealOutputChannelOn: RevealOutputChannelOn.Info,
			initializationOptions: {
				compilerVenv: compilerVenv
			}
		};
		const lc = new LanguageClient('inmanta-ls', 'Inmanta Language Server', serverOptions, clientOptions);
		lc.onReady().catch(errorhandler.rejected);

		// Create the language client and start the client.
		const disposable = lc.start();

		// Push the disposable to the context's subscriptions so that the
		// client can be deactivated on extension deactivation
		context.subscriptions.push(disposable);
		return disposable;
	}

	const enable: boolean = workspace.getConfiguration('inmanta').ls.enabled;

	function createVenvIfNotExists() {
		const pp: string = workspace.getConfiguration('inmanta').pythonPath;
		if (pp && fs.existsSync(pp)) {
			return pp;
		} else {
			window.showInformationMessage(`No Python3 interpreter found at "${pp}". Falling back to default virtual environment`);
		}
		const venvBaseDir = Uri.joinPath(context.globalStorageUri, ".env").fsPath;
		const venvPath = Uri.joinPath(context.globalStorageUri, ".env", "bin", "python3").fsPath;

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
			const cwdCommand: string = path.dirname(pathOpenedFile).replace(/^file:\/\//, "");
			const pythonPath: string = workspace.getConfiguration('inmanta').pythonPath;
			const child = cp.spawn(pythonPath, ["-m", "inmanta.app", "-vv", "export"], {cwd: `${cwdCommand}`});

			if(exportToServerChannel === null) {
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
		running = startPipe();
	}

	function stopIfRunning() {
		if (running !== undefined) {
			running.dispose();
			running = undefined;
		}

	}

	context.subscriptions.push(workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('inmanta')) {
			const enable: boolean = workspace.getConfiguration('inmanta').ls.enabled;

			stopIfRunning();

			if (enable) {
				startPipe();
			}
		}
	}));

	let exportToServerChannel: OutputChannel = null;
	registerExportCommand();
}
