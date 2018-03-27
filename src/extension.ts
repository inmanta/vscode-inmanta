'use strict';

import * as net from 'net';

const cp = require("child_process");

import { workspace, ExtensionContext, Disposable } from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind, Executable } from 'vscode-languageclient';

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
	}

	function start_pipe() {
		const pp: string = workspace.getConfiguration('inmanta').pythonPath

		const serverOptions: ServerOptions = {
			command: pp,
			args: ["-m", "inmantals.pipeserver"]
		};
		const clientOptions: LanguageClientOptions = {
			documentSelector: [{ scheme: 'file', language: 'inmanta' }]
		}
		let lc = new LanguageClient('inmanta-ls', 'Inmane Language Server', serverOptions, clientOptions);
		// Create the language client and start the client.
		let disposable = lc.start();

		// Push the disposable to the context's subscriptions so that the 
		// client can be deactivated on extension deactivation
		context.subscriptions.push(disposable);
		return disposable
	}

	const enable: boolean = workspace.getConfiguration('inmanta').ls.enabled

	var running: Disposable
	if (enable) {
		running = start_pipe()
	}

	function stop_if_running() {
		running.dispose()
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
