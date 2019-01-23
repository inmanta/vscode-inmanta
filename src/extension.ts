'use strict';

import * as net from 'net';

import * as cp from 'child_process';
import * as fs from 'fs';

import { workspace, ExtensionContext, Disposable, window } from 'vscode';
import { RevealOutputChannelOn, LanguageClient, LanguageClientOptions, ServerOptions, TransportKind, Executable, ErrorHandler, Message, ErrorAction, CloseAction } from 'vscode-languageclient';

export function activate(context: ExtensionContext) {

	//let serverOptions: ServerOptions = {command:'python3', args:['-m', 'inmanta-lsp']};

	function start_tcp() {
		// have to start server by hand, debugging only
		let serverOptions: ServerOptions = function () {
			return new Promise((resolve, reject) => {
				var client = new net.Socket();
				client.connect(5432, "127.0.0.1", function () {
					resolve({
						reader: client,
						writer: client
					});
				});
			});
		}

		// Options to control the language client
		let clientOptions: LanguageClientOptions = {
			// Register the server for inmanta documents
			documentSelector: [{ scheme: 'file', language: 'inmanta' }]
		}

		let lc = new LanguageClient('inmanta-ls', 'Inmane Language Server', serverOptions, clientOptions)
		// Create the language client and start the client.
		let disposable = lc.start();

		// Push the disposable to the context's subscriptions so that the 
		// client can be deactivated on extension deactivation
		context.subscriptions.push(disposable);
		return disposable
	}

	class LsErrorHandler implements ErrorHandler{

		_serverOptions: Executable
		_child:cp.ChildProcess
		
		constructor(serverOptions: Executable){
			this._serverOptions = serverOptions
		}

		not_installed(){
			const pp: string = workspace.getConfiguration('inmanta').pythonPath

			window.showErrorMessage(`Inmanta Language Server not installed, run "${pp} -m pip install inmantals" ?`, 'Yes', 'No').then(
				(answer) => {
					if(answer=='Yes'){
						const child = cp.spawn(pp, ["-m", "pip", "install", "--pre", "inmantals"])
						child.on('close',(code, signal)=>{
							if(code==0){
								start_pipe()
							}else{
								
								window.showErrorMessage(`Inmanta Language Server install failed with code ${code}`)
							}
						})
					}
				}
			)
		}

		diagnose(){
			if(this._child != undefined)
				return
			
			const pp: string = workspace.getConfiguration('inmanta').pythonPath

			if(!fs.existsSync(pp)){
				window.showErrorMessage("No python3 interperter found at `" + pp + "`. Please update the config setting `inmanta.pythonPath` to point to a valid python interperter.")
				return
			}

			const script = "import sys\ntry:\n  import inmantals.pipeserver\n  sys.exit(0)\nexcept: sys.exit(3)"

			this._child = cp.spawn(this._serverOptions.command, ["-c", script])

			this._child.on('close', (code) => {
				if(code == 3){
					this.not_installed()
				}else{
					const data = this._child.stdout.read()
					window.showErrorMessage("Inmanta Language Server could not start, could not determined cause of failure"+data)
				}
				this._child = undefined
			});
			
		}

		error(error: Error, message: Message, count: number): ErrorAction{
			this.diagnose()
			return ErrorAction.Shutdown
		}		
		
		closed(): CloseAction {
			this.diagnose()
			return CloseAction.DoNotRestart
		}

		rejected(reason){
			window.showErrorMessage('Inmanta Language Server: rejected to start'+ reason);
		}

	}

	function start_pipe() {
		const pp: string = workspace.getConfiguration('inmanta').pythonPath

		if(!fs.existsSync(pp)){
			window.showErrorMessage("Inmanta Language Server could not start, no python3 interperter found at `" + pp + "`. Please update the config setting `inmanta.pythonPath` to point to a valid python interperter.")
			return
		}

		const serverOptions: Executable = {
			command: pp,
			args: ["-m", "inmantals.pipeserver"],
		};

		const errorhandler = new LsErrorHandler(serverOptions)

		const clientOptions: LanguageClientOptions = {
			documentSelector: [{ scheme: 'file', language: 'inmanta' }],
			errorHandler: errorhandler,
			revealOutputChannelOn: RevealOutputChannelOn.Info
		}
		let lc = new LanguageClient('inmanta-ls', 'Inmane Language Server', serverOptions, clientOptions);
		lc.onReady().catch(errorhandler.rejected)

		// Create the language client and start the client.
		let disposable = lc.start();

		// Push the disposable to the context's subscriptions so that the 
		// client can be deactivated on extension deactivation
		context.subscriptions.push(disposable);
		return disposable
	}

	const enable: boolean = workspace.getConfiguration('inmanta').ls.enabled

	var running: Disposable = undefined

	if (enable) {
		running = start_pipe()
	}

	function stop_if_running() {
		if(running != undefined){
			running.dispose()
			running = undefined
		}
		
	}

	context.subscriptions.push(workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('inmanta')) {
			const enable: boolean = workspace.getConfiguration('inmanta').ls.enabled

			stop_if_running()

			if (enable) {
				start_pipe()
			}
		}
	}));

}
