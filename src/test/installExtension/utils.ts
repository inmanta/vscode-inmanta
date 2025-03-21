import * as path from 'path';
import * as fs from 'fs-extra';
import * as cp from 'child_process';
import { Uri, workspace, OutputChannel, commands, extensions } from 'vscode';

/**
 * Path to the test workspace directory
 */
export const workspaceUri: Uri = Uri.file(path.resolve(__dirname, '../../../src/test/installExtension/workspace'));

/**
 * Path to the main model file in the test workspace
 */
export const modelUri: Uri = Uri.file(path.resolve(workspaceUri.fsPath, 'main.cf'));

/**
 * Absolute path to the test workspace directory
 */
export const testWorkspacePath = path.resolve(__dirname, '../../../src/test/installExtension/workspace');

/**
 * Assert with timeout
 * @param assertion Function containing the assertion
 * @param timeoutMs Timeout in milliseconds
 * @param message Error message if timeout is reached
 */
export async function assertWithTimeout(assertion: () => Promise<void> | void, timeoutMs: number, message: string): Promise<void> {
    return new Promise(async (resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(`Timeout: ${message}`));
        }, timeoutMs);

        try {
            await assertion();
            clearTimeout(timeout);
            resolve();
        } catch (error) {
            clearTimeout(timeout);
            reject(error);
        }
    });
}

/**
 * Sets up a test workspace with necessary configuration files and structure.
 * Creates a .vscode directory, cleans up existing virtual environments,
 * creates a basic .cf file, and initializes VS Code settings.
 * @returns Promise that resolves when the workspace is set up
 */
export async function setupTestWorkspace(): Promise<void> {
    // Ensure workspace directory exists with a .vscode folder
    await fs.ensureDir(path.join(testWorkspacePath, '.vscode'));

    // Clean up all venvs that start with .venv
    const files = await fs.readdir(testWorkspacePath);
    for (const file of files) {
        if (file.startsWith('.venv')) {
            const venvPathToDelete = path.join(testWorkspacePath, file);
            await fs.remove(venvPathToDelete);
        }
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

/**
 * Cleans up the test environment by resetting Python interpreter settings
 * and removing all virtual environments that start with .venv.
 * @returns Promise that resolves when cleanup is complete
 */
export async function cleanupTestEnvironment(): Promise<void> {
    // Wait for any pending operations
    await new Promise(resolve => setTimeout(resolve, 100));

    try {
        // Reset Python interpreter setting
        await workspace.getConfiguration('python').update('defaultInterpreterPath', undefined, true);
    } catch (error) {
        console.warn('Failed to reset Python interpreter setting:', error);
    }

    // Clean up all venvs that start with .venv
    const files = await fs.readdir(testWorkspacePath);
    for (const file of files) {
        if (file.startsWith('.venv')) {
            const venvPathToDelete = path.join(testWorkspacePath, file);
            await fs.remove(venvPathToDelete);
        }
    }
}

/**
 * Creates a new Python virtual environment in the test workspace.
 * @param name Name of the virtual environment directory (defaults to '.venv')
 * @returns Promise that resolves to the path of the Python interpreter in the new virtual environment
 */
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

/**
 * Creates a test output channel that logs messages to the console.
 * Implements the VS Code OutputChannel interface for test purposes.
 * @returns An OutputChannel implementation that writes to console
 */
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
        show(): void {
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
export async function installLanguageServer(outputChannel?: OutputChannel): Promise<void> {
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

        output.appendLine('=== LANGUAGE SERVER INSTALLATION TRIGGERED ===');
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
 * Checks if the language server is installed in the current Python environment.
 * Uses pip to verify if the inmantals package is installed.
 * @param pythonPath Optional path to the Python interpreter to check. If not provided, uses the VS Code Python setting
 * @param outputChannel Optional output channel for logging the check process
 * @returns Promise that resolves to true if the language server is installed, false otherwise
 */
export async function isLanguageServerInstalled(pythonPath?: string, outputChannel?: OutputChannel): Promise<boolean> {
    const interpreter = pythonPath || workspace.getConfiguration('python').get<string>('defaultInterpreterPath');
    if (!interpreter) {
        outputChannel?.appendLine(`[INMANTA TEST] No interpreter found`);
        return false;
    }

    try {
        // Use pip show instead of pip list - more reliable for checking specific packages
        const result = cp.execSync(`"${interpreter}" -m pip show inmantals`, {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore']
        });

        outputChannel?.appendLine(`[INMANTA TEST] pip show executed successfully`);
        outputChannel?.appendLine(`[INMANTA TEST] pip show output: ${result}`);

        // If we get here, the package exists
        return true;
    } catch (error) {
        // pip show returns non-zero if package is not installed
        outputChannel?.appendLine(`[INMANTA TEST] Language server not installed: ${error}`);
        return false;
    }
}

/**
 * Checks if the Inmanta language server process is currently running.
 * Uses platform-specific commands (tasklist on Windows, ps on Unix) to check for the process.
 * @returns Promise that resolves to true if the language server is running, false otherwise
 */
export async function isLanguageServerRunning(): Promise<boolean> {
    // Check if there's a running language server process
    // This is platform-specific and might need adjustment
    try {
        if (process.platform === 'win32') {
            const result = cp.execSync('tasklist | findstr "inmanta-language-server"', {
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'ignore']
            });
            return result.includes('inmanta-language-server');
        } else {
            const result = cp.execSync('ps aux | grep inmanta-language-server | grep -v grep', {
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'ignore']
            });
            return result.trim() !== '';
        }
    } catch (_error) {
        // If the command fails, the process is not running
        return false;
    }
}

/**
 * Sets up a complete test environment including Python extension activation,
 * workspace configuration, virtual environment creation, and language server installation.
 * @param testOutput OutputChannel for logging the setup progress
 * @returns Promise that resolves to the path of the created Python interpreter
 */
export async function setupTestEnvironment(testOutput: OutputChannel): Promise<string> {
    testOutput.appendLine('=================================== SETUP STARTED ============================================');

    try {
        // Check if Python extension is available
        testOutput.appendLine('Checking Python extension...');
        const pythonExtension = extensions.getExtension('ms-python.python');
        if (!pythonExtension) {
            testOutput.appendLine('WARNING: Python extension not found');
        } else {
            // Ensure Python extension is activated
            if (!pythonExtension.isActive) {
                testOutput.appendLine('Activating Python extension...');
                try {
                    await pythonExtension.activate();
                    testOutput.appendLine('Python extension activated successfully');
                } catch (error) {
                    testOutput.appendLine(`WARNING: Failed to activate Python extension: ${error}`);
                }
            } else {
                testOutput.appendLine('Python extension is already active');
            }
        }

        // Setup workspace
        testOutput.appendLine('Setting up test workspace...');
        try {
            await setupTestWorkspace();
            testOutput.appendLine('Test workspace setup completed');
        } catch (error) {
            testOutput.appendLine(`ERROR: Failed to setup workspace: ${error}`);
            throw error;
        }

        // Create virtual environment
        testOutput.appendLine('Creating virtual environment...');
        let pythonPath;
        try {
            pythonPath = await createVirtualEnv();
            testOutput.appendLine(`Created virtual environment at: ${pythonPath}`);
        } catch (error) {
            testOutput.appendLine(`ERROR: Failed to create virtual environment: ${error}`);
            throw error;
        }

        // Configure Python interpreter
        testOutput.appendLine('Configuring Python interpreter path...');
        try {
            await workspace.getConfiguration('python').update('defaultInterpreterPath', pythonPath, true);
            testOutput.appendLine('Updated Python interpreter path (global)');

            const updatedPath = workspace.getConfiguration('python').get('defaultInterpreterPath');
            testOutput.appendLine(`Verified Python interpreter path is now: ${updatedPath}`);
        } catch (error) {
            testOutput.appendLine(`WARNING: Failed to configure Python interpreter: ${error}`);
            throw error;
        }

        // Wait for configuration to be applied
        testOutput.appendLine('Waiting for configuration to be applied...');
        await new Promise(resolve => setTimeout(resolve, 3000));
        testOutput.appendLine('Wait completed');

        // Open a .cf file to trigger the language server check
        testOutput.appendLine('Opening .cf file...');
        await commands.executeCommand('vscode.open', modelUri);
        testOutput.appendLine('.cf file opened');

        // Install language server
        testOutput.appendLine('Installing language server...');
        try {
            await installLanguageServer(testOutput);
            testOutput.appendLine('Language server installation completed');
        } catch (error) {
            testOutput.appendLine(`WARNING: Error during language server installation: ${error}`);
            throw error;
        }

        // Close all editors
        testOutput.appendLine('Closing all editors...');
        try {
            await commands.executeCommand('workbench.action.closeAllEditors');
            testOutput.appendLine('All editors closed');
        } catch (error) {
            testOutput.appendLine(`WARNING: Failed to close editors: ${error}`);
        }

        // install the project
        testOutput.appendLine('Installing project...');
        try {
            await commands.executeCommand('inmanta.projectInstall');
            testOutput.appendLine('Project installation completed');
        } catch (error) {
            testOutput.appendLine(`WARNING: Failed to install project: ${error}`);
            throw error;
        }

        // Wait for VS Code to settle
        testOutput.appendLine('Waiting for VS Code to settle...');
        await new Promise(resolve => setTimeout(resolve, 3000));
        testOutput.appendLine('=================================== SETUP COMPLETED SUCCESSFULLY ============================================');

        return pythonPath;
    } catch (error) {
        testOutput.appendLine(`=== SETUP FAILED: ${error} ===`);
        testOutput.appendLine(`Stack trace: ${error.stack}`);
        throw error;
    }
}

/**
 * Performs cleanup of the test environment, including waiting for pending operations
 * to complete and cleaning up test resources.
 * @param testOutput OutputChannel for logging the teardown progress
 * @param additionalVenvs Optional array of additional virtual environment names to clean up
 * @returns Promise that resolves when teardown is complete
 */
export async function teardownTestEnvironment(testOutput: OutputChannel): Promise<void> {
    try {
        testOutput.appendLine('Starting teardown...');

        // Wait a bit before cleanup to allow pending operations to complete
        await new Promise(resolve => setTimeout(resolve, 500));

        testOutput.appendLine('Cleaning up test environment...');
        try {
            await cleanupTestEnvironment();
            testOutput.appendLine('Test environment cleanup completed');
        } catch (error) {
            testOutput.appendLine(`Error during cleanup: ${error}`);
        }

        testOutput.appendLine('=================================== TEARDOWN COMPLETED ============================================');
    } catch (error) {
        console.error('Error during teardown:', error);
        // Don't rethrow here to avoid masking test failures
    }
}

/**
 * Monitors a log file for compilation status messages.
 * Continuously reads the specified log file until it finds a message indicating
 * that compilation has either succeeded or failed, or until the timeout is reached.
 * 
 * @param logPath The path to the logging file to monitor
 * @param timeout Maximum time in milliseconds to wait for compilation to complete
 * @returns Promise that resolves to true if compilation succeeded, false if it failed
 * @throws Error if the timeout is reached before compilation completes
 */
export function waitForCompile(logPath: string, timeout: number): Promise<boolean> {
    const start = Date.now();
    return new Promise<boolean>((resolve, reject) => {
        const readLogInterval = setInterval(() => {
            if (Date.now() - start > timeout) {
                clearInterval(readLogInterval);
                reject(new Error(`Timeout of ${timeout}ms reached`));
            } else {
                fs.ensureFileSync(logPath);
                fs.readFile(logPath, 'utf-8', (err, data) => {
                    if (err) {
                        clearInterval(readLogInterval);
                        console.log(`Got an error while waiting for compile: ${err}`);
                    } else if (data.includes('Compilation succeeded')) {
                        clearInterval(readLogInterval);
                        resolve(true);
                    } else if (data.includes('Compilation failed')) {
                        clearInterval(readLogInterval);
                        resolve(false);
                    }
                });
            }
        }, 500);
    });
}