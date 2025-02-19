'use strict';

import { workspace, ExtensionContext, extensions, window, commands, WorkspaceFolder, TextDocument, TextEditor } from 'vscode';
import { getInterpreterDetails, updateVenvSelector, initializePython, onDidChangePythonInterpreter } from './python';
import { LanguageServer, LsErrorHandler } from './language_server';
import { InmantaCommands } from './commands';
import { addSetupAssistantButton } from './walkthrough_button';
import { createOutputChannel, getConfiguration, getOuterMostWorkspaceFolder, getWorkspaceFolder, onDidChangeConfiguration } from './vscode_api';
import { checkIfConfigurationChanged } from './settings';
import { registerLogger, traceLog } from './logTracer';

let inmantaCommands: InmantaCommands;
let lastActiveFolder: WorkspaceFolder = undefined;

/*
    Keep track of active language servers per independant top-most folder in the workspace.
    We lazily spin up a new language server any time a .cf file living inside a folder is opened for the first time.
    Once the language server is up, it is added to the languageServers map with the uri of the top-most folder it is
    responsible for as a key. This allows the servers to be properly stopped if/when the folder is removed from the
    workspace
*/
export const languageServers: Map<string, LanguageServer> = new Map();

/**
 * Activates the extension.
 * 
 * @param {ExtensionContext} context - The context in which the extension is activated.
 * @throws Will throw an error if the Python extension is not found.
 */
export async function activate(context: ExtensionContext) {
    const outputChannel = createOutputChannel('Inmanta');
    context.subscriptions.push(registerLogger(outputChannel));

    const pythonExtension = extensions.getExtension('ms-python.python');

    // Get and activate the Python extension instance
    if (pythonExtension === undefined) {
        throw Error("Python extension not found");
    }

    traceLog("Activate Python extension");
    await pythonExtension.activate();

    // Initialize the Python extension
    await initializePython(context.subscriptions);

    // Add the setup assistant button
    addSetupAssistantButton();

    // Create a new instance of InmantaCommands to register commands
    inmantaCommands = new InmantaCommands(context);

    inmantaCommands.registerCommand(`inmanta.openWalkthrough`, () => {
        commands.executeCommand(`workbench.action.openWalkthrough`, `Inmanta.inmanta#inmanta.walkthrough`, false);
    });

    /**
     * Handles the change of the active text editor.
     * @param {TextEditor} event - The text editor that is currently active.
     */
    function changeActiveTextEditor(event: TextEditor) {
        // Any time we select a .cf file from another folder in the workspace we have to override the already registered commands
        // so that they operate on the desired folders, with the correct virtual environment.
        if (event === undefined) {
            return;
        }

        updateVenvSelector(event.document);

        const uri = event.document.uri;

        let folder = getWorkspaceFolder(uri);

        if (folder === undefined) {
            // This happens for example when looking at a .py file living in a venv outside of the current workspace, in which case we must hide our button
            return;
        }

        folder = getOuterMostWorkspaceFolder(folder);

        if (event.document.languageId !== 'inmanta' || (event.document.uri.scheme !== 'file')) {
            return;
        }
        if (folder === lastActiveFolder) {
            return;
        }
        lastActiveFolder = folder;
        const languageServer = languageServers.get(folder.uri.toString());

        inmantaCommands.registerCommands(languageServer);
    }

    /**
     * Handles the opening of a text document.
     * 
     * If the document is a .cf file, a new language server is started for the folder that contains the document.
     * If a language server already exists for the folder, it is reused.
     * If the folder doesn't have a language server yet, a new one is started.
     * 
     * @param {TextDocument} document - The text document that was opened.
     * @returns A promise that resolves when the text document is opened.
     */
    async function didOpenTextDocument(document: TextDocument): Promise<void> {
        updateVenvSelector(document);

        // We are only interested in .cf files
        if (document.languageId !== 'inmanta' || (document.uri.scheme !== 'file')) {
            return;
        }

        const uri = document.uri;

        let folder = getWorkspaceFolder(uri);
        // Files outside a folder can't be handled.
        if (!folder) {
            return;
        }
        // If we have nested workspace folders we only start a language server on the outer most workspace folder.
        folder = getOuterMostWorkspaceFolder(folder);
        lastActiveFolder = folder;
        const folderURI = folder.uri.toString();

        if (!languageServers.has(folderURI)) {
            /*
                The document that was just opened is not living inside a folder that has a language server responsible for it.
                We need to start a new language server for this folder. For a seamless user experience, we mimick the behaviour
                of the pylance extension:

                - Case 1: a venv for this folder has already been selected in the past and persisted by vs code in the persistent
                storage ==> we simply use this venv and start a new language server. see https://github.com/microsoft/vscode-python/wiki/Setting-descriptions#pythondefaultinterpreterpath)

                - Case 2: this is a fresh folder with no pre-selected venv
                    * if a workspace-wide venv has been selected -> use this one
                    * use the default environment used by the python extension (https://code.visualstudio.com/docs/python/environments#_where-the-extension-looks-for-environments)

            */

            const newInterpreter = await getInterpreterDetails(folder.uri);
            const newPythonPath = newInterpreter.path ? newInterpreter.path[0] : undefined;

            const errorHandler = new LsErrorHandler(folder);

            const languageserver = new LanguageServer(context, newPythonPath, folder, errorHandler);
            traceLog("created LanguageServer");

            inmantaCommands.registerCommands(languageserver);

            // Start the language server if enabled in the workspace configuration
            const enable: boolean = getConfiguration('inmanta', folder).get('ls.enabled', false);
            traceLog(`enable language server: ${enable}`);
            if (enable) {
                await languageserver.startOrRestartLS(true);
            }

            traceLog(`adding ${folder.uri.toString()} to languageServers`);


            languageServers.set(folder.uri.toString(), languageserver);
        }

    }

    workspace.onDidOpenTextDocument(didOpenTextDocument);
    workspace.textDocuments.forEach(didOpenTextDocument);

    window.onDidChangeActiveTextEditor((event: TextEditor) => changeActiveTextEditor(event));

    workspace.onDidChangeWorkspaceFolders((event) => {
        traceLog("workspaces changed" + String(event));
        for (const folder of event.removed) {
            const ls = languageServers.get(folder.uri.toString());
            if (ls) {
                languageServers.delete(folder.uri.toString());
                ls.stopServerAndClient();
                ls.cleanOutputChannel();
            }
        }
    });

    // Subscribe to workspace configuration changes and restart the affected language server(s) if necessary
    context.subscriptions.push(onDidChangeConfiguration(async (event) => {
        const promises: Thenable<void>[] = [];
        for (const ls of languageServers.values()) {
            if (checkIfConfigurationChanged(event, 'inmanta')) {
                promises.push(ls.startOrRestartLS());
            }
        }
        await Promise.all(promises);
    }));

    // Subscribe to python interpreter changes and restart the affected language server(s) if necessary
    context.subscriptions.push(onDidChangePythonInterpreter(async () => {
        traceLog('Python interpreter changed');
        updateVenvSelector(window.activeTextEditor?.document);

        traceLog(`Restarting Language servers due to python interpreter change.`);
        const promises: Thenable<void>[] = [];
        for (const ls of languageServers.values()) {
            promises.push(ls.startOrRestartLS());
        }
        await Promise.all(promises);
    }));

}

export async function deactivate(): Promise<void> {
    const promises: Thenable<void>[] = [];
    for (const ls of languageServers.values()) {
        promises.push(ls.stopServerAndClient());
    }
    await Promise.all(promises);
}


export function getLanguageMap(): Map<string, LanguageServer> {
    return languageServers;
}

export function getLastActiveFolder(): WorkspaceFolder {
    return lastActiveFolder;
}