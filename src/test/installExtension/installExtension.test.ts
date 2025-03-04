import * as assert from 'assert';
import { after, describe, it, beforeEach, afterEach, before } from 'mocha';
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

describe('Language Server Install Extension', () => {
    const testWorkspacePath = path.resolve(__dirname, '../../../src/test/installExtension/workspace');
    const venvPath = path.join(testWorkspacePath, '.venv');
    let showErrorMessageSpy: sinon.SinonSpy;
    let showInfoMessageSpy: sinon.SinonSpy;
    let testOutput: OutputChannel;
    let pythonPath: string;

    before(async () => {
        // Ensure workspace directory exists with a .vscode folder
        await fs.ensureDir(path.join(testWorkspacePath, '.vscode'));

        // Create a basic workspace file
        const workspaceFile = path.join(testWorkspacePath, 'test.code-workspace');
        await fs.writeJSON(workspaceFile, {
            folders: [{ path: '.' }],
            settings: {}
        });

        // Clean up any existing venv
        await fs.remove(venvPath);

        // Create fresh venv for the suite
        pythonPath = await createVirtualEnv();

        // Create a basic .cf file to work with
        const mainCfPath = path.join(testWorkspacePath, 'main.cf');
        if (!await fs.pathExists(mainCfPath)) {
            await fs.writeFile(mainCfPath, 'entity Test:\n    string name\nend\n');
        }
    });

    beforeEach(async () => {
        // Setup spies
        showErrorMessageSpy = sinon.spy(window, 'showErrorMessage');
        showInfoMessageSpy = sinon.spy(window, 'showInformationMessage');

        // Create output channel
        testOutput = createOutputChannel('Inmanta Extension Tests');

        // Ensure workspace is opened before trying to modify settings
        await commands.executeCommand('workbench.action.closeAllEditors');

        // Wait a bit for VS Code to settle
        await new Promise(resolve => setTimeout(resolve, 1000));
    });

    afterEach(async () => {
        // Wait a bit before cleanup to allow pending operations to complete
        await new Promise(resolve => setTimeout(resolve, 100));

        // Restore spies
        showErrorMessageSpy.restore();
        showInfoMessageSpy.restore();

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

        // Clean up
        await fs.remove(venvPath);
        await fs.writeFile(logPath, "");
    });

    async function createVirtualEnv(): Promise<string> {
        // Find python executable
        const pythonCmd = process.platform === 'win32' ? 'python' : 'python3.12';

        // Create virtual environment in the workspace folder
        cp.execSync(`${pythonCmd} -m venv ${venvPath}`, {
            cwd: workspaceUri.fsPath  // Use workspace folder as working directory
        });

        // Return path to python interpreter in venv
        const pythonPath = path.join(
            venvPath,
            process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
        );
        return pythonPath;
    }

    it('Should guide through setup assistant when no venv is selected', async () => {
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

        // Make sure extension is activated
        const inmanta = extensions.getExtension('inmanta.inmanta');
        if (!inmanta.isActive) {
            await inmanta.activate();
        }
        assert.ok(inmanta.isActive, 'Extension should be activated');

        // Try to open walkthrough
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

    }).timeout(60000);


});