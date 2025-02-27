import { Disposable, Event, EventEmitter, StatusBarAlignment, TextDocument, Uri, window } from 'vscode';
import { traceError, traceLog } from './logTracer';
import { PythonExtension, ResolvedEnvironment } from '@vscode/python-extension';
import { workspace } from 'vscode';
import { getGlobalSettings, getWorkspaceSettings } from './settings';

export interface IInterpreterDetails {
    path?: string[];
    resource?: Uri;
}

const onDidChangePythonInterpreterEvent = new EventEmitter<IInterpreterDetails>();

export const onDidChangePythonInterpreter: Event<IInterpreterDetails> = onDidChangePythonInterpreterEvent.event;

let _api: PythonExtension | undefined;

const envSelector = window.createStatusBarItem(StatusBarAlignment.Right, 100);

/**
 * Gets the Python extension API.
 * @returns A promise that resolves to the Python extension API or undefined.
 */
async function getPythonExtensionAPI(): Promise<PythonExtension | undefined> {
    if (_api) {
        return _api;
    }
    _api = await PythonExtension.api();
    return _api;
}

/**
 * Initializes the Python extension.
 * @param disposables An array to which disposables can be added.
 */
export async function initializePython(disposables: Disposable[]): Promise<void> {
    try {
        const api = await getPythonExtensionAPI();

        if (api) {
            disposables.push(
                api.environments.onDidChangeActiveEnvironmentPath((e) => {
                    onDidChangePythonInterpreterEvent.fire({ path: [e.path], resource: e.resource?.uri });
                }),
            );

            traceLog('Waiting for interpreter from python extension.');
            onDidChangePythonInterpreterEvent.fire(await getInterpreterDetails());
        }
    } catch (error) {
        traceError('Error initializing python: ', error);
        window.showErrorMessage(`Error: Python may not be installed properly. \nCannot initialize Python extension. ${error}`);
    }
}

/**
 * Resolves the given interpreter.
 * @param interpreter An array containing the interpreter path.
 * @returns A promise that resolves to the resolved environment or undefined.
 */
export async function resolveInterpreter(interpreter: string[]): Promise<ResolvedEnvironment | undefined> {
    const api = await getPythonExtensionAPI();
    return api?.environments.resolveEnvironment(interpreter[0]);
}

/**
 * Gets the details of the current interpreter.
 * @param resource An optional URI of the resource.
 * @returns A promise that resolves to the interpreter details.
 */
export async function getInterpreterDetails(resource?: Uri): Promise<IInterpreterDetails> {
    const api = await getPythonExtensionAPI();
    const environment = await api?.environments.resolveEnvironment(
        api?.environments.getActiveEnvironmentPath(resource),
    );
    if (environment?.executable.uri && pythonVersionSupported(environment)) {
        traceLog(`Resolved interpreter: ${environment?.executable.uri.fsPath}`);
        return { path: [environment?.executable.uri.fsPath], resource };
    }

    return { path: undefined, resource };
}

/**
 * Checks if the resolved Python environment version is supported.
 * @param resolved - The resolved Python environment.
 * @returns True if the version is supported, false otherwise.
 */
export function pythonVersionSupported(resolved: ResolvedEnvironment | undefined): boolean {
    const version = resolved?.version;
    traceLog(`Detected Python version: ${version?.major}.${version?.minor}`);
    if (version?.major === 3 && version?.minor >= 11) {
        return true;
    }
    traceError(`Python version ${version?.major}.${version?.minor} is not supported.`);
    traceError(`Selected python path: ${resolved?.executable.uri?.fsPath}`);
    traceError('Supported versions are 3.11 and above.');

    return false;
}

/**
 * Toggles the interpreter selector button to the status bar.
 * @param document - The active text document.
 */
export async function updateVenvSelector(document: TextDocument) {
    if (document && (document.languageId === 'inmanta' || document.languageId === 'cf' || document.uri.fsPath.endsWith('.cf'))) {
        const workspaceFolder = workspace.getWorkspaceFolder(document.uri);
        const settings = workspaceFolder ? await getWorkspaceSettings('inmanta', workspaceFolder, true) : await getGlobalSettings('inmanta', true);

        const interpreterPath = settings.interpreter.length > 0 ? settings.interpreter[0] : 'No Interpreter';
        traceLog(`Using interpreter: ${interpreterPath}`);

        const resolvedEnv = await resolveInterpreter([interpreterPath]);
        const version = resolvedEnv ? `${resolvedEnv.version?.major}.${resolvedEnv.version?.minor}.${resolvedEnv.version?.micro}` : 'No Interpreter';
        const envName = resolvedEnv?.environment?.name || '';

        envSelector.text = `Python ${version} (${envName})`;
        envSelector.show();

        envSelector.command = 'python.setInterpreter';
        envSelector.tooltip = interpreterPath;

    } else {
        envSelector.hide();
    }
}
