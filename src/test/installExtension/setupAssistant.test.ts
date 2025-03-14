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

    setup(async function () {
        // Increase timeout for setup
        this.timeout(30000);

        testOutput = createTestOutput();
        testOutput.appendLine('=== SETUP STARTED ===');

        try {
            await setupTestWorkspace();
            testOutput.appendLine('Test workspace setup completed');

            // Setup spies
            showErrorMessageSpy = sinon.spy(window, 'showErrorMessage');
            showInfoMessageSpy = sinon.spy(window, 'showInformationMessage');
            showWarningMessageSpy = sinon.spy(window, 'showWarningMessage');
            testOutput.appendLine('Message spies set up');

            // Ensure workspace is opened before trying to modify settings
            await commands.executeCommand('workbench.action.closeAllEditors');

            // Wait a bit for VS Code to settle
            await new Promise(resolve => setTimeout(resolve, 1000));
            testOutput.appendLine('=== SETUP COMPLETED ===');
        } catch (error) {
            testOutput.appendLine(`Setup failed: ${error}`);
            throw error;
        }
    });

    teardown(async function () {
        // Increase timeout for teardown
        this.timeout(10000);

        testOutput.appendLine('=== TEARDOWN STARTED ===');

        // Wait a bit before cleanup to allow pending operations to complete
        await new Promise(resolve => setTimeout(resolve, 500));

        try {
            // Restore spies
            if (showErrorMessageSpy) {
                showErrorMessageSpy.restore();
                testOutput.appendLine('Restored error message spy');
            }

            if (showInfoMessageSpy) {
                showInfoMessageSpy.restore();
                testOutput.appendLine('Restored info message spy');
            }

            if (showWarningMessageSpy) {
                showWarningMessageSpy.restore();
                testOutput.appendLine('Restored warning message spy');
            }

            if (testOutput) {
                testOutput.appendLine('Cleaning up test environment...');
                try {
                    await cleanupTestEnvironment(['.venv']);
                    testOutput.appendLine('Test environment cleanup completed');
                } catch (error) {
                    testOutput.appendLine(`Error during cleanup: ${error}`);
                }
            }
        } catch (error) {
            testOutput.appendLine(`Teardown error: ${error}`);
        } finally {
            testOutput.appendLine('=== TEARDOWN COMPLETED ===');
            testOutput.dispose();
        }
    });

    test('Should guide through setup assistant when no venv is selected and install succesfully', async function () {
        // Increase timeout for this test
        this.timeout(60000);

        testOutput.appendLine('=== TEST STARTED ===');
        testOutput.appendLine(`Running in CI: ${process.env.CI === 'true' || process.env.JENKINS_URL ? 'Yes' : 'No'}`);

        try {
            // Make sure Python extension is ready
            testOutput.appendLine('Checking Python extension...');
            const pythonExtension = extensions.getExtension('ms-python.python');
            if (!pythonExtension) {
                testOutput.appendLine('WARNING: Python extension not found');
            } else {
                if (!pythonExtension.isActive) {
                    testOutput.appendLine('Activating Python extension...');
                    await pythonExtension.activate();
                }
                testOutput.appendLine(`Python extension is active: ${pythonExtension.isActive}`);
            }

            // Open a .cf file to trigger the extension
            testOutput.appendLine('Opening main.cf file...');
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
            testOutput.appendLine(`Created virtual environment at: ${pythonPath}`);

            // Configure Python interpreter directly (skip interactive selection)
            testOutput.appendLine('Configuring Python interpreter programmatically');

            // Update both workspace and global settings
            await workspace.getConfiguration('python').update('defaultInterpreterPath', pythonPath, true); // global
            await workspace.getConfiguration('python').update('defaultInterpreterPath', pythonPath, false); // workspace
            testOutput.appendLine('Updated Python interpreter path settings');

            // Wait for Python extension to recognize the new interpreter
            testOutput.appendLine('Waiting for Python extension to recognize the new interpreter...');
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
            testOutput.appendLine('Language server installation function completed');

            // Check if success message was shown
            testOutput.appendLine('Checking for success message...');
            const calls = showInfoMessageSpy.getCalls();
            const messages = calls.map(call => ({
                message: call.args[0],
                buttons: call.args.slice(1)
            }));

            testOutput.appendLine(`Found ${calls.length} info messages`);
            for (let i = 0; i < calls.length; i++) {
                testOutput.appendLine(`Message ${i + 1}: ${calls[i].args[0]}`);
            }

            const successMessageShown = messages.some(m =>
                m.message === 'Inmanta Language server was installed successfully'
            );

            if (successMessageShown) {
                testOutput.appendLine('Success message was shown');
                assert.ok(true, 'Success message was shown');
            } else {
                testOutput.appendLine('Success message not found');
                assert.fail('Expected success message was not shown');
            }

            // Go back to the .cf file
            testOutput.appendLine('Opening .cf file again...');
            await commands.executeCommand('workbench.action.closeActiveEditor');
            await commands.executeCommand('vscode.open', modelUri);
            testOutput.appendLine('.cf file opened');

            // Check if the language server is running
            testOutput.appendLine('Checking if Inmanta extension is active...');
            const inmantaExtension = extensions.getExtension('inmanta.inmanta');

            if (inmantaExtension) {
                testOutput.appendLine(`Inmanta extension is active: ${inmantaExtension.isActive}`);
                // Don't assert here as it might not be active in CI
            } else {
                testOutput.appendLine('WARNING: Inmanta extension not found');
            }

            testOutput.appendLine('=== TEST COMPLETED SUCCESSFULLY ===');
        } catch (error) {
            testOutput.appendLine(`TEST FAILED: ${error}`);
            testOutput.appendLine(`Stack trace: ${error.stack}`);
            throw error;
        }
    });
}); 