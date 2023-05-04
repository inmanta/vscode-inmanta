import * as fs from 'fs';
import { workspace, WorkspaceFolder, Uri, Location } from 'vscode';
import { LanguageServer } from './language_server';
import {getSortedWorkspaceFolders} from './extension';

/**
 * Checks if a file or directory exists at the specified path.
 * @param filePath The path to the file or directory.
 * @returns true if the file or directory exists, false otherwise.
 */
export function fileOrDirectoryExists(filePath: string): boolean {
	try {
	  fs.accessSync(filePath);
	  return true;
	} catch (error) {
	  return false;
	}
  }

/**
 * Logs a message to the console with a timestamp and a tag.
 * @param message The message to be logged.
 */
export function log(message: string) {
	console.log(`[${new Date().toUTCString()}][vscode-inmanta] ${message}`);
}


export function logMap(map: Map<string, LanguageServer>) {
	for (let key of map.keys()) {
		console.log(key);
	}
}

/*
	The following functions sortedWorkspaceFolders and getOuterMostWorkspaceFolder are taken from the vs-code extension example at
	https://github.com/microsoft/vscode-extension-samples/blob/main/lsp-multi-server-sample/client/src/extension.ts
	under this license: https://github.com/microsoft/vscode-extension-samples/blob/main/LICENSE
*/

/*
Copyright (c) Microsoft Corporation

All rights reserved.

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation
files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy,
modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software
is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED *AS IS*, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS
BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

function sortedWorkspaceFolders(): string[] {
	let _sortedWorkspaceFolders = getSortedWorkspaceFolders();
	if (_sortedWorkspaceFolders === void 0) {
		_sortedWorkspaceFolders = workspace.workspaceFolders ? workspace.workspaceFolders.map(folder => {
			let result = folder.uri.toString();
			if (result.charAt(result.length - 1) !== '/') {
				result = result + '/';
			}
			return result;
		}).sort(
			(a, b) => {
				return a.length - b.length;
			}
		) : [];
	}
	return _sortedWorkspaceFolders;
}


export function getOuterMostWorkspaceFolder(folder: WorkspaceFolder): WorkspaceFolder {
	const sorted = sortedWorkspaceFolders();
	for (const element of sorted) {
		let uri = folder.uri.toString();
		if (uri.charAt(uri.length - 1) !== '/') {
			uri = uri + '/';
		}
		if (uri.startsWith(element)) {
			return workspace.getWorkspaceFolder(Uri.parse(element))!;
		}
	}
	return folder;
}


export function isLocation(loc: any): loc is Location {
	return loc.uri !== undefined;
}
