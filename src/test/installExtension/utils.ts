import * as path from 'path';
import * as fs from 'fs-extra';
import * as cp from 'child_process';
import { Uri, workspace, OutputChannel, commands, window, extensions } from 'vscode';
import { createOutputChannel } from '../../vscode_api';

export const workspaceUri: Uri = Uri.file(path.resolve(__dirname, '../../../src/test/installExtension/workspace'));
export const modelUri: Uri = Uri.file(path.resolve(workspaceUri.fsPath, 'main.cf'));
export const logPath: string = process.env.INMANTA_LS_LOG_PATH || '/tmp/vscode-inmanta.log';
export const testWorkspacePath = path.resolve(__dirname, '../../../src/test/installExtension/workspace');

export async function setupTestWorkspace(): Promise<void> {
    // Ensure workspace directory exists with a .vscode folder
    await fs.ensureDir(path.join(testWorkspacePath, '.vscode'));

    // Clean up any existing venvs
    const venvs = ['.venv', '.venv2'];
    for (const venv of venvs) {
        const venvPathToDelete = path.join(testWorkspacePath, venv);
        await fs.remove(venvPathToDelete);
    }

    // Create a basic .cf file to work with
    const mainCfPath = path.join(testWorkspacePath, 'main.cf');
    if (!await fs.pathExists(mainCfPath)) {
        await fs.writeFile(mainCfPath, 'entity Test:\n    string name\nend\n');
    }

    // Initialize settings.json with default values
    const settings = {
        "inmanta.ls.enabled": true,
        "python.defaultInterpreterPath": process.env.INMANTA_EXTENSION_TEST_ENV || "/tmp/venv"
    };

    const settingsPath = path.join(testWorkspacePath, '.vscode', 'settings.json');
    await fs.writeJSON(settingsPath, settings, { spaces: 4 });

    // Wait for VS Code to detect the settings change
    await new Promise(resolve => setTimeout(resolve, 1000));
}

export async function cleanupTestEnvironment(venvs: string[]): Promise<void> {
    // Wait for any pending operations
    await new Promise(resolve => setTimeout(resolve, 100));

    try {
        // Reset Python interpreter setting
        await workspace.getConfiguration('python').update('defaultInterpreterPath', undefined, true);
    } catch (error) {
        console.warn('Failed to reset Python interpreter setting:', error);
    }

    // Clean up all extra venvs. the default venv is not deleted since it will be used for the rest of the suite.
    for (const venv of venvs) {
        const venvPathToDelete = path.join(testWorkspacePath, venv);
        await fs.remove(venvPathToDelete);
    }

    await fs.writeFile(logPath, "");
}

export async function createVirtualEnv(name: string = '.venv'): Promise<string> {
    // Find python executable
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3.12';

    // Create path for the named virtual environment
    const venvLocation = path.join(testWorkspacePath, name);

    // Create virtual environment in the workspace folder
    cp.execSync(`${pythonCmd} -m venv ${venvLocation}`, {
        cwd: workspaceUri.fsPath  // Use workspace folder as working directory
    });

    // Return path to python interpreter in venv
    const pythonPath = path.join(
        venvLocation,
        process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
    );
    return pythonPath;
}

export function createTestOutput(): OutputChannel {
    // Create a console-based implementation of OutputChannel
    return {
        name: 'Inmanta Extension Tests',
        append(value: string): void {
            process.stdout.write(value);
        },
        appendLine(value: string): void {
            console.log(`[INMANTA TEST] ${value}`);
        },
        clear(): void {
            // Can't clear console in a running process
            console.log('[INMANTA TEST] --- CLEAR ---');
        },
        show(columnOrPreserveFocus?: any, preserveFocus?: boolean): void {
            // Handle both overloads
            console.log('[INMANTA TEST] --- SHOW OUTPUT ---');
        },
        hide(): void {
            // Can't hide console
            console.log('[INMANTA TEST] --- HIDE OUTPUT ---');
        },
        dispose(): void {
            // Nothing to dispose for console
            console.log('[INMANTA TEST] --- DISPOSED ---');
        },
        replace(value: string): void {
            // Can't replace in console, just append
            console.log(`[INMANTA TEST] --- REPLACE WITH: ${value} ---`);
        }
    };
}

/**
 * Installs the Inmanta Language Server
 * @param outputChannel Optional output channel to log progress
 * @returns A promise that resolves when the installation is complete
 */
export async function installLanguageServer(outputChannel?: OutputChannel, venvFolder: string = '.venv'): Promise<void> {
    const output = outputChannel || createTestOutput();
    output.appendLine('=== LANGUAGE SERVER INSTALLATION STARTED ===');
    output.appendLine(`Running in CI: ${process.env.CI === 'true' || process.env.JENKINS_URL ? 'Yes' : 'No'}`);

    // Check if the Inmanta extension is available
    const inmantaExtension = extensions.getExtension('inmanta.inmanta');
    if (!inmantaExtension) {
        output.appendLine('ERROR: Inmanta extension not found');
        throw new Error('Inmanta extension not found');
    } else {
        output.appendLine(`Inmanta extension found, isActive: ${inmantaExtension.isActive}`);

        // Activate the extension if it's not already active
        if (!inmantaExtension.isActive) {
            try {
                output.appendLine('Activating Inmanta extension...');
                await inmantaExtension.activate();
                output.appendLine('Inmanta extension activated successfully');
            } catch (error) {
                output.appendLine(`ERROR: Failed to activate Inmanta extension: ${error}`);
                throw new Error(`Failed to activate Inmanta extension: ${error}`);
            }
        }
    }

    // Wait for command to be registered
    let attempts = 0;
    const maxAttempts = 10;
    const retryDelay = 1000;

    output.appendLine('Checking for inmanta.installLS command...');

    while (attempts < maxAttempts) {
        try {
            const allCommands = await commands.getCommands();
            const inmantaCommands = allCommands.filter(cmd => cmd.startsWith('inmanta.'));

            if (attempts === 0 || attempts === maxAttempts - 1) {
                output.appendLine(`Available Inmanta commands: ${inmantaCommands.join(', ')}`);
            }

            if (allCommands.includes('inmanta.installLS')) {
                output.appendLine('inmanta.installLS command found');
                break;
            }

            attempts++;
            output.appendLine(`Waiting for inmanta.installLS command to be registered (attempt ${attempts}/${maxAttempts})`);
            await new Promise(resolve => setTimeout(resolve, retryDelay));

            if (attempts >= maxAttempts) {
                output.appendLine('ERROR: Command not registered after maximum attempts');
                throw new Error('inmanta.installLS command not registered after maximum attempts');
            }
        } catch (error) {
            output.appendLine(`ERROR during command check: ${error}`);
            throw error;
        }
    }

    output.appendLine('Executing inmanta.installLS command...');

    try {
        // Execute the installation command
        await commands.executeCommand('inmanta.installLS');
        output.appendLine('inmanta.installLS command executed successfully');

        // Wait for installation to complete (increased timeout)
        output.appendLine('Waiting for installation to complete...');
        await new Promise(resolve => setTimeout(resolve, 10000));

        output.appendLine('=== LANGUAGE SERVER INSTALLATION COMPLETED ===');
    } catch (error) {
        output.appendLine(`ERROR executing inmanta.installLS: ${error}`);
        throw error;
    } finally {
        // If this is a temporary output channel created by this function, dispose it
        if (!outputChannel) {
            output.dispose();
        }
    }
}

/**
 * Checks if the Inmanta Language Server is installed in the current Python environment
 * This can be used to trigger the warning message if the language server is not installed
 * @param outputChannel Optional output channel to log progress
 */
export async function checkLanguageServerInstallation(outputChannel?: OutputChannel): Promise<void> {
    const output = outputChannel || createTestOutput();
    output.appendLine('Checking if Inmanta Language Server is installed...');

    try {
        // Try to execute a command that would check the language server
        if (await commands.getCommands().then(cmds => cmds.includes('inmanta.checkLanguageServer'))) {
            output.appendLine('Found inmanta.checkLanguageServer command, executing it');
            await commands.executeCommand('inmanta.checkLanguageServer');
        } else if (await commands.getCommands().then(cmds => cmds.includes('inmanta.restartLS'))) {
            output.appendLine('Found inmanta.restartLS command, executing it');
            await commands.executeCommand('inmanta.restartLS');
        } else {
            // If no specific command is available, try to trigger the language server by opening a .cf file
            output.appendLine('No specific check command found, opening a .cf file to trigger language server');

            // First close all editors
            await commands.executeCommand('workbench.action.closeAllEditors');

            // Then open a .cf file
            await commands.executeCommand('vscode.open', modelUri);

            // Simulate some activity to trigger language server checks
            await commands.executeCommand('cursorMove', { to: 'right' });
            await commands.executeCommand('cursorMove', { to: 'left' });
        }

        // Wait a bit for any warnings to appear
        await new Promise(resolve => setTimeout(resolve, 2000));

        output.appendLine('Language server check completed');
    } catch (error) {
        output.appendLine(`Error checking language server: ${error}`);
        // This error is expected if the language server is not installed
    } finally {
        if (!outputChannel) {
            output.dispose();
        }
    }
} 