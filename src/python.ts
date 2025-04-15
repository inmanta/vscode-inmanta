import { Disposable, Event, EventEmitter, StatusBarAlignment, TextDocument, Uri, window, extensions } from 'vscode';
import { traceError, traceLog } from './logTracer';
import { workspace } from 'vscode';
import { getGlobalSettings, getWorkspaceSettings } from './settings';

/**
 * Interface representing details about a Python interpreter.
 * Used for communicating interpreter changes and settings.
 */
export interface IInterpreterDetails {
    /**
     * Array containing the path to the Python interpreter.
     * May be undefined if no interpreter is set.
     */
    path?: string[];
    /**
     * The VS Code resource URI associated with this interpreter.
     * May be undefined for global interpreter settings.
     */
    resource?: Uri;
}

/**
 * Event emitter for Python interpreter changes.
 * Used to notify the extension when the Python interpreter configuration changes.
 */
const onDidChangePythonInterpreterEvent = new EventEmitter<IInterpreterDetails>();

/**
 * Event that fires when the Python interpreter changes.
 * Subscribers can use this to update their interpreter-dependent functionality.
 */
export const onDidChangePythonInterpreter: Event<IInterpreterDetails> = onDidChangePythonInterpreterEvent.event;

/**
 * Status bar item showing the current Python environment.
 */
const envSelector = window.createStatusBarItem(StatusBarAlignment.Right, 100);

/**
 * Gets the Python extension API.
 * Caches the API instance for subsequent calls.
 * 
 * @returns Promise that resolves to the Python extension API or undefined if not available
 */
async function getPythonExtensionAPI(): Promise<any> {
    const pythonExtension = extensions.getExtension('ms-python.python');
    if (!pythonExtension) {
        return undefined;
    }
    if (!pythonExtension.isActive) {
        await pythonExtension.activate();
    }
    return pythonExtension.exports;
}

/**
 * Initializes the Python extension integration.
 * Sets up event listeners for interpreter changes and performs initial interpreter detection.
 * 
 * @param disposables Array to which event disposables will be added
 * @throws Will show an error message if Python is not properly installed
 */
export async function initializePython(disposables: Disposable[]): Promise<void> {
    try {
        const api = await getPythonExtensionAPI();

        if (api) {
            disposables.push(
                api.environments.onDidChangeActiveEnvironmentPath((event: any) => {
                    onDidChangePythonInterpreterEvent.fire({ path: [event.path], resource: event.resource?.uri });
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
 * Resolves a Python interpreter path to its full environment details.
 * 
 * @param interpreter Array containing the interpreter path to resolve
 * @returns Promise that resolves to the full environment details or undefined if not found
 */
export async function resolveInterpreter(interpreter: string[]): Promise<any> {
    const api = await getPythonExtensionAPI();
    return api?.environments.resolveEnvironment(interpreter[0]);
}

/**
 * Gets the details of the current Python interpreter.
 * Resolves the active environment and checks if it's supported.
 * 
 * @param resource Optional URI to get workspace-specific interpreter details
 * @returns Promise that resolves to the interpreter details
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
 * Checks if a Python environment version is supported by the extension.
 * Currently supports Python 3.11 and above.
 * 
 * @param resolved The resolved Python environment to check
 * @returns True if the version is supported (Python 3.11+), false otherwise
 */
export function pythonVersionSupported(resolved: any): boolean {
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
 * Updates the Python environment selector in the status bar.
 * Shows the current Python version and environment name for Inmanta files,
 * hides the selector for other file types.
 * 
 * @param document The active text document to check
 */
export async function updateVenvSelector(document: TextDocument | undefined) {
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
