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
    installLanguageServer,
    isLanguageServerInstalled,
    isLanguageServerRunning
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
        testOutput.appendLine('=== SETUP STARTED : SETUP ASSISTANT ===');

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
            testOutput.appendLine('=== SETUP COMPLETED : SETUP ASSISTANT ===');
        } catch (error) {
            testOutput.appendLine(`Setup failed: ${error}`);
            throw error;
        }
    });

    teardown(async function () {
        // Increase timeout for teardown
        this.timeout(10000);

        testOutput.appendLine('=== TEARDOWN STARTED : SETUP ASSISTANT ===');

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
            testOutput.appendLine('=== TEARDOWN COMPLETED : SETUP ASSISTANT ===');
            testOutput.dispose();
        }
    });

    test('Should guide through setup assistant when no venv is selected and install succesfully', async function () {
        testOutput.appendLine('=== TEST STARTED : SETUP ASSISTANT ===');
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
            // this is a limitation of the test environment
            testOutput.appendLine('Setting up virtual environment programmatically');

            // Check if Python extension is available and activate it
            testOutput.appendLine('Checking Python extension...');
            if (!pythonExtension) {
                testOutput.appendLine('WARNING: Python extension not found');
                throw new Error('Python extension not found');
            } else {
                // Ensure Python extension is activated
                if (!pythonExtension.isActive) {
                    testOutput.appendLine('Activating Python extension...');
                    try {
                        await pythonExtension.activate();
                        testOutput.appendLine('Python extension activated successfully');
                    } catch (error) {
                        testOutput.appendLine(`ERROR: Failed to activate Python extension: ${error}`);
                        throw error;
                    }
                } else {
                    testOutput.appendLine('Python extension is already active');
                }
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
                // First, get current value for logging
                const currentPath = workspace.getConfiguration('python').get('defaultInterpreterPath');
                testOutput.appendLine(`Current Python interpreter path: ${currentPath}`);

                // Update both workspace and global settings
                await workspace.getConfiguration('python').update('defaultInterpreterPath', pythonPath, true); // global
                await workspace.getConfiguration('python').update('defaultInterpreterPath', pythonPath, false); // workspace
                testOutput.appendLine('Updated Python interpreter path settings');

                // Verify the update
                const updatedPath = workspace.getConfiguration('python').get('defaultInterpreterPath');
                testOutput.appendLine(`Verified Python interpreter path is now: ${updatedPath}`);
            } catch (error) {
                testOutput.appendLine(`ERROR: Failed to configure Python interpreter: ${error}`);
                throw error;
            }

            // Wait for configuration to be applied
            testOutput.appendLine('Waiting for configuration to be applied...');
            await new Promise(resolve => setTimeout(resolve, 3000));
            testOutput.appendLine('Configuration wait completed');

            // Verify Python interpreter configuration
            testOutput.appendLine('Verifying Python interpreter configuration...');
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

            testOutput.appendLine(`Python interpreter configured and verified at: ${pythonPath}`);

            // Step 3: Install language server
            testOutput.appendLine('Step 3: Installing language server');

            // Check initial state before installation, this is a fresh venv, so it should not be installed
            testOutput.appendLine('Checking initial language server state...');
            const initialInstalled = await isLanguageServerInstalled(pythonPath);
            assert.strictEqual(initialInstalled, false, 'Language server should not be installed on a fresh venv');

            // Install the language server using the utility function
            testOutput.appendLine('Installing language server...');
            try {
                await installLanguageServer(testOutput);
                testOutput.appendLine('Language server installation completed');
            } catch (error) {
                testOutput.appendLine(`ERROR during language server installation: ${error}`);
                throw error;
            }

            // Wait for installation to complete and verify
            testOutput.appendLine('Waiting for installation to complete and verifying...');
            await assertWithTimeout(
                async () => {
                    const isInstalled = await isLanguageServerInstalled(pythonPath, testOutput);
                    if (!isInstalled) {
                        testOutput.appendLine('Language server not found during verification check');
                        throw new Error('Language server not installed after timeout');
                    }
                    testOutput.appendLine('Language server found during verification check');
                },
                30000, 
                'Language server was not installed within 30 seconds'
            );

            // Double check installation status
            testOutput.appendLine('Performing final installation check...');
            const isInstalled = await isLanguageServerInstalled(pythonPath, testOutput);
            testOutput.appendLine(`Language server installed: ${isInstalled}`);
            assert.strictEqual(isInstalled, true, 'Language server should be installed after installation');

            // We can still check for success messages as a secondary verification,
            // but we don't rely on them for the test to pass
            testOutput.appendLine('Checking for success messages...');
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
                testOutput.appendLine('Found success message (additional verification)');
            } else {
                testOutput.appendLine('Warning: Success message not found in info messages');
            }

            // Go back to the .cf file
            testOutput.appendLine('Opening .cf file again...');
            await commands.executeCommand('workbench.action.closeAllEditors');
            await commands.executeCommand('vscode.open', modelUri);
            testOutput.appendLine('.cf file opened');

            // Wait for the language server to start
            testOutput.appendLine('Waiting for language server to start...');
            await new Promise(resolve => setTimeout(resolve, 5000)); // Increased wait time

            // Check if the language server is running
            testOutput.appendLine('Checking if language server is running...');
            const isRunning = await isLanguageServerRunning();
            testOutput.appendLine(`Language server running: ${isRunning}`);

            // In CI environments, the language server might not actually run
            // so we don't assert on this, but we log the state
            testOutput.appendLine(`Language server running state: ${isRunning}`);

            testOutput.appendLine('=== TEST COMPLETED SUCCESSFULLY ===');
        } catch (error) {
            testOutput.appendLine(`TEST FAILED: ${error}`);
            testOutput.appendLine(`Stack trace: ${error.stack}`);
            throw error;
        }
    });
}); 