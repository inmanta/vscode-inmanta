import * as assert from 'assert';
import { suite, test, setup, teardown } from 'mocha';
import * as sinon from 'sinon';
import { window, commands, workspace, extensions, OutputChannel } from 'vscode';
import { assertWithTimeout } from '../helpers';
import {
    modelUri,
    setupTestWorkspace,
    cleanupTestEnvironment,
    createVirtualEnv,
    createTestOutput,
    installLanguageServer
} from './utils';

suite('Language Server Setup Assistant', () => {
    let showErrorMessageSpy: sinon.SinonSpy;
    let showInfoMessageSpy: sinon.SinonSpy;
    let showWarningMessageSpy: sinon.SinonSpy;
    let testOutput: OutputChannel;

    setup(async () => {
        await setupTestWorkspace();
        // Setup spies
        showErrorMessageSpy = sinon.spy(window, 'showErrorMessage');
        showInfoMessageSpy = sinon.spy(window, 'showInformationMessage');
        showWarningMessageSpy = sinon.spy(window, 'showWarningMessage');
        // Create output channel
        testOutput = createTestOutput();

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
        await cleanupTestEnvironment(['.venv']);
    });

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

        // Install the language server using the utility function
        await installLanguageServer(testOutput);

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
            20000,
            'Success message was not shown within 20 seconds'
        );

        // Go back to the .cf file
        await commands.executeCommand('workbench.action.closeActiveEditor');
        await commands.executeCommand('vscode.open', modelUri);

        // assert that the language server is running
        const languageServer = extensions.getExtension('inmanta.inmanta');
        assert.ok(languageServer.isActive, 'Language server should be activated');
    });
}); 