import * as assert from 'assert';
import { after, suite, test, setup, teardown, before } from 'mocha';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as sinon from 'sinon';
import * as cp from 'child_process';

import { Uri, window, commands, workspace, extensions, OutputChannel } from 'vscode';
import { assertWithTimeout } from '../helpers';
import { createOutputChannel } from '../../vscode_api';

const workspaceUri: Uri = Uri.file(path.resolve(__dirname, '../../../src/test/installExtension/workspace'));
const modelUri: Uri = Uri.file(path.resolve(workspaceUri.fsPath, 'main.cf'));
const logPath: string = process.env.INMANTA_LS_LOG_PATH || '/tmp/vscode-inmanta.log';

suite('Language Server Install Extension', () => {
    const testWorkspacePath = path.resolve(__dirname, '../../../src/test/installExtension/workspace');
    let showErrorMessageSpy: sinon.SinonSpy;
    let showInfoMessageSpy: sinon.SinonSpy;
    let showWarningMessageSpy: sinon.SinonSpy;
    let testOutput: OutputChannel;

    before(async () => {
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
    });

    setup(async () => {
        // Setup spies
        showErrorMessageSpy = sinon.spy(window, 'showErrorMessage');
        showInfoMessageSpy = sinon.spy(window, 'showInformationMessage');
        showWarningMessageSpy = sinon.spy(window, 'showWarningMessage');
        // Create output channel
        testOutput = createOutputChannel('Inmanta Extension Tests');

        // Ensure workspace is opened before trying to modify settings
        await commands.executeCommand('workbench.action.closeAllEditors');

        // Wait a bit for VS Code to settle
        await new Promise(resolve => setTimeout(resolve, 1000));
    });

    teardown(async () => {
        // Wait a bit before cleanup to allow pending operations to complete
        await new Promise(resolve => setTimeout(resolve, 100));

        // Restore spies
        showErrorMessageSpy.restore();
        showInfoMessageSpy.restore();
        showWarningMessageSpy.restore();

        if (testOutput) {
            testOutput.dispose();
        }
    });

    after(async () => {
        // Wait for any pending operations
        await new Promise(resolve => setTimeout(resolve, 100));

        try {
            // Reset Python interpreter setting
            await workspace.getConfiguration('python').update('defaultInterpreterPath', undefined, true);
        } catch (error) {
            console.warn('Failed to reset Python interpreter setting:', error);
        }

        // Clean up all extra venvs. the default venv is not deleted since it will be used for the rest of the suite.
        const venvs = ['.venv2'];
        for (const venv of venvs) {
            const venvPathToDelete = path.join(testWorkspacePath, venv);
            await fs.remove(venvPathToDelete);
        }


        await fs.writeFile(logPath, "");
    });

    async function createVirtualEnv(name: string = '.venv'): Promise<string> {
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

    test('Should guide through setup assistant when no venv is selected and install succesfully', async () => {
        // Make sure Python extension is ready
        const pythonExtension = extensions.getExtension('ms-python.python');
        if (!pythonExtension.isActive) {
            await pythonExtension.activate();
        }
        assert.ok(pythonExtension.isActive, 'Python extension should be activated');

        // Open a .cf file to trigger the extension
        const document = await workspace.openTextDocument(modelUri);
        await window.showTextDocument(document);
        testOutput.appendLine('Opened main.cf file');

        // Open walkthrough
        try {
            await commands.executeCommand('inmanta.openWalkthrough');
            testOutput.appendLine('Walkthrough command executed');
        } catch (error) {
            testOutput.appendLine(`Note: Could not open walkthrough UI in test environment: ${error}`);
        }

        // Skip interactive venv creation/selection and set it up programmatically
        testOutput.appendLine('Setting up virtual environment programmatically (skipping interactive steps)');
        const pythonPath = await createVirtualEnv();

        // Configure Python interpreter directly (skip interactive selection)
        testOutput.appendLine('Configuring Python interpreter programmatically');

        // Update both workspace and global settings
        await workspace.getConfiguration('python').update('defaultInterpreterPath', pythonPath, true); // global
        await workspace.getConfiguration('python').update('defaultInterpreterPath', pythonPath, false); // workspace

        // Wait for Python extension to recognize the new interpreter
        await assertWithTimeout(
            async () => {
                const config = workspace.getConfiguration('python');
                const currentPath = config.get('defaultInterpreterPath');
                testOutput.appendLine(`Current interpreter path: ${currentPath}`);
                assert.strictEqual(
                    currentPath,
                    pythonPath,
                    'Python interpreter should be set to the new venv'
                );
            },
            5000,
            'Python interpreter was not properly configured within 5 seconds'
        );

        testOutput.appendLine(`Python interpreter configured at: ${pythonPath}`);

        // Step 3: Install language server
        testOutput.appendLine('Step 3: Installing language server');

        // Wait for command to be registered
        await assertWithTimeout(
            async () => {
                const allCommands = await commands.getCommands();
                testOutput.appendLine('Available Inmanta commands: ' + allCommands.filter(cmd => cmd.startsWith('inmanta.')).join(', '));
                assert.ok(
                    allCommands.includes('inmanta.installLS'),
                    'inmanta.installLS command should be registered'
                );
            },
            5000,
            'inmanta.installLS command was not registered within 5 seconds'
        );

        // Now execute the command
        await commands.executeCommand('inmanta.installLS');

        // Assert success message was shown
        await assertWithTimeout(
            async () => {
                const calls = showInfoMessageSpy.getCalls();
                const messages = calls.map(call => ({
                    message: call.args[0],
                    buttons: call.args.slice(1)
                }));

                assert.ok(
                    messages.some(m => m.message === 'Inmanta Language server was installed successfully'),
                    `Expected success message but got:\n${messages.length ?
                        messages.map(m => `- "${m.message}" with buttons [${m.buttons.join(', ')}]`).join('\n') :
                        'No info messages shown'
                    }`
                );
                testOutput.appendLine('Language server installed successfully');
            },
            10000,
            'Success message was not shown within 10 seconds'
        );

        // Go back to the .cf file
        await commands.executeCommand('workbench.action.closeActiveEditor');
        await commands.executeCommand('vscode.open', modelUri);

        // assert that the language server is running
        const languageServer = extensions.getExtension('inmanta.inmanta');
        assert.ok(languageServer.isActive, 'Language server should be activated');

    });

    test('Should detect if we change venv and no server is installed', async () => {
        // Create a second virtual environment
        const pythonPath2 = await createVirtualEnv(".venv2");

        // Configure Python interpreter directly (skip interactive selection)
        testOutput.appendLine('Configuring Python interpreter programmatically for new venv');

        // Update both workspace and global settings
        await workspace.getConfiguration('python').update('defaultInterpreterPath', pythonPath2, true); // global
        await workspace.getConfiguration('python').update('defaultInterpreterPath', pythonPath2, false); // workspace

        // Wait for Python extension to recognize the new interpreter
        await assertWithTimeout(
            async () => {
                const config = workspace.getConfiguration('python');
                const currentPath = config.get('defaultInterpreterPath');
                testOutput.appendLine(`Current interpreter path: ${currentPath}`);
                assert.strictEqual(currentPath, pythonPath2, 'Python interpreter should be set to the new venv');
            },
            1000,
            'Python interpreter was not properly configured within 10 seconds'
        );

        // Go back to the .cf file to ensure we're in the right context
        await commands.executeCommand('workbench.action.closeActiveEditor');
        await commands.executeCommand('vscode.open', modelUri);

        // give the editor a moment to trigger restart of the language server
        testOutput.appendLine('Waiting for language server to restart...');
        await new Promise(resolve => setTimeout(resolve, 3000));
        testOutput.appendLine('Continuing after wait...');

        // expect a warning message that the language server is not installed now that we changed the venv
        await assertWithTimeout(
            async () => {
                const calls = showWarningMessageSpy.getCalls();
                testOutput.appendLine(`Warning message spy calls: ${calls.length}`);
                if (calls.length > 0) {
                    testOutput.appendLine(`First warning message: ${calls[0].firstArg}`);
                }
                assert.ok(calls.length > 0, 'Warning message should be shown');
                assert.ok(calls[0].firstArg.includes('Inmanta Language Server not installed.'), 'Warning message should mention the language server is not installed');
            },
            1000,
            'Warning message was not shown within 10 seconds'
        );
    });
});