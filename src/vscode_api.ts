// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import * as fs from 'fs';
import {
    commands,
    ConfigurationScope,
    Disposable,
    Location,
    LogOutputChannel,
    Uri,
    window,
    workspace,
    WorkspaceConfiguration,
    WorkspaceFolder,
} from 'vscode';
import { traceInfo } from './logTracer';


/**
 * Creates an output channel with the specified name.
 * @param name - The name of the output channel.
 * @returns The created LogOutputChannel.
 */
export function createOutputChannel(name: string): LogOutputChannel {
    return window.createOutputChannel(name, { log: true });
}

/**
 * Gets the workspace configuration for the specified configuration name and scope. 
 * @param config - The configuration name.
 * @param scope - The configuration scope.
 * @returns The workspace configuration.
 */
export function getConfiguration(config: string, scope?: ConfigurationScope): WorkspaceConfiguration {
    return workspace.getConfiguration(config, scope);
}

const registeredCommands: Map<string, Disposable> = new Map();

/**
 * Registers a command with the specified callback.
 * @param command - The command to register.
 * @param callback - The callback to execute when the command is invoked.
 * @param thisArg - The `this` context for the callback.
 * @returns A Disposable that unregisters the command when disposed.
 */
export function registerCommand(command: string, callback: (...args: any[]) => any, thisArg?: any): Disposable {
    traceInfo(`registering command ${command}`);
    if (registeredCommands.has(command)) {
        registeredCommands.get(command)!.dispose();
    }
    const disposable = commands.registerCommand(command, callback, thisArg);
    registeredCommands.set(command, disposable);
    return disposable;
}

/**
 * Event that is fired when the workspace configuration changes.
 */
export const { onDidChangeConfiguration } = workspace;

/**
 * Gets the workspace folders.
 * @returns An array of WorkspaceFolder objects.
 */
export function getWorkspaceFolders(): readonly WorkspaceFolder[] {
    return workspace.workspaceFolders ?? [];
}

/**
 * Gets the workspace folder for the specified URI.
 * @param uri - The URI to get the workspace folder for.
 * @returns The WorkspaceFolder for the URI, or undefined if not found.
 */
export function getWorkspaceFolder(uri: Uri): WorkspaceFolder | undefined {
    return workspace.getWorkspaceFolder(uri);
}

/**
 * Checks if a file or directory exists at the specified path.
 * @param filePath The path to the file or directory.
 * @returns true if the file or directory exists, false otherwise.
 */
export function fileOrDirectoryExists(filePath: string): boolean {
    try {
        fs.accessSync(filePath);
        return true;
    } catch (_error) {
        return false;
    }
}


/*
    The following functions sortedWorkspaceFolders and getOuterMostWorkspaceFolder are taken from the vs-code extension example at
    https://github.com/microsoft/vscode-extension-samples/blob/main/lsp-multi-server-sample/client/src/extension.ts
    under this license: https://github.com/microsoft/vscode-extension-samples/blob/main/LICENSE
*/

workspace.onDidChangeWorkspaceFolders(() => _sortedWorkspaceFolders = undefined);

let _sortedWorkspaceFolders: string[] | undefined;

/**
 * Returns the workspace folders sorted by their depth on disk
 * @returns the sorted workspace folders
 */
function sortedWorkspaceFolders(): string[] {
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


/**
 * Returns the outer most workspace folder for the given folder
 * @param folder the folder to get the outer most workspace folder for
 * @returns the outer most workspace folder
 */
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

/**
 * Checks if the given object is a Location.
 * @param loc - The object to check.
 * @returns true if the object is a Location, false otherwise.
 */
export function isLocation(loc: any): loc is Location {
    return loc.uri !== undefined;
}
