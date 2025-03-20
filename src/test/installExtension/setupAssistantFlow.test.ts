import * as assert from 'assert';
import { suite, test, setup, teardown } from 'mocha';
import { commands, workspace, OutputChannel, extensions } from 'vscode';
import {
    modelUri,
    setupTestWorkspace,
    cleanupTestEnvironment,
    createVirtualEnv,
    createTestOutput,
    isLanguageServerRunning
} from './utils';

suite('Setup Assistant Flow Test', () => {
    let testOutput: OutputChannel;

    setup(async function () {
        testOutput = createTestOutput();
        testOutput.appendLine('=================================== SETUP STARTED ============================================');

        try {
            // Setup workspace with necessary files
            await setupTestWorkspace();
            testOutput.appendLine('Test workspace setup completed');

            // Close all editors to start fresh
            await commands.executeCommand('workbench.action.closeAllEditors');
            testOutput.appendLine('=================================== SETUP COMPLETED ============================================');
        } catch (error) {
            testOutput.appendLine(`Setup failed: ${error}`);
            throw error;
        }
    });

    teardown(async function () {
        try {
            testOutput.appendLine('Starting teardown...');

            // Clean up test environment
            await cleanupTestEnvironment([".venv"]);
            testOutput.appendLine('Test environment cleanup completed');

            testOutput.appendLine('Teardown completed');
            testOutput.dispose();
        } catch (error) {
            console.error('Error during teardown:', error);
        }
    });

    test('Should follow setup Assistant steps successfully', async function () {
        testOutput.appendLine('=== TEST STARTED: SETUP ASSISTANT FLOW ===');

        try {
            // Step 1: Check and activate Python extension
            testOutput.appendLine('Step 1: Checking Python extension...');
            const pythonExtension = extensions.getExtension('ms-python.python');
            assert.ok(pythonExtension, 'Python extension should be available');

            if (!pythonExtension.isActive) {
                testOutput.appendLine('Activating Python extension...');
                await pythonExtension.activate();
            }
            assert.ok(pythonExtension.isActive, 'Python extension should be active');


            // Step 2: Verify Inmanta extension is available and active
            testOutput.appendLine('STEP 2: Checking Inmanta extension...');
            const inmantaExtension = extensions.getExtension('inmanta.inmanta');
            assert.ok(inmantaExtension, 'Inmanta extension should be available');

            // Open a cf file to trigger the extension activation
            testOutput.appendLine('Opening .cf file...');
            await commands.executeCommand('vscode.open', modelUri);
            testOutput.appendLine('.cf file opened');

            // open the walkthrough
            testOutput.appendLine('Opening walkthrough...');
            await commands.executeCommand('inmanta.openWalkthrough');
            testOutput.appendLine('Walkthrough opened');

            // Verify Inmanta commands are available
            testOutput.appendLine('Checking available commands:');
            const maxAttempts = 10;
            let attempt = 0;
            let installCommandAvailable = false;

            while (attempt < maxAttempts && !installCommandAvailable) {
                attempt++;
                testOutput.appendLine(`Waiting for inmanta.installLS command to be registered (attempt ${attempt}/${maxAttempts})`);

                const allCommands = await commands.getCommands();
                const inmantaCommands = allCommands.filter(cmd => cmd.startsWith('inmanta.'));
                testOutput.appendLine(`Available Inmanta commands: ${inmantaCommands.join(', ')}`);

                if (allCommands.includes('inmanta.installLS')) {
                    installCommandAvailable = true;
                    testOutput.appendLine('inmanta.installLS command is available');
                    break;
                }

                if (attempt < maxAttempts) {
                    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second between attempts
                }
            }

            if (!installCommandAvailable) {
                throw new Error('inmanta.installLS command not registered after maximum attempts');
            }

            // Step 3: Create and configure virtual environment
            testOutput.appendLine('STEP 3: Creating virtual environment...');
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

            // Step 4: Install language server
            testOutput.appendLine('STEP 4: Installing language server...');
            try {
                // Execute the installation command
                await commands.executeCommand('inmanta.installLS');

                testOutput.appendLine('inmanta.installLS command triggered');
            } catch (error) {
                testOutput.appendLine(`ERROR executing inmanta.installLS: ${error}`);
                throw error;
            }

            // Give it a moment to complete
            await new Promise(resolve => setTimeout(resolve, 10000));

            // Confirm the extension is installed
            testOutput.appendLine('STEP 5: Verifying language server is running...');

            // Open a .cf file to trigger the language server
            await commands.executeCommand('vscode.open', modelUri);
            testOutput.appendLine('.cf file opened');

            // Wait for the language server to initialize
            // The server needs some time to start and register its capabilities
            await new Promise(resolve => setTimeout(resolve, 5000));

            // check if the language server is active now
            assert.ok(inmantaExtension.isActive, 'Language server should be active');

            // check if the language server is running now
            assert.ok(isLanguageServerRunning(), 'Language server should be running');

            testOutput.appendLine('=================================== TEST COMPLETED SUCCESSFULLY ============================================');
        } catch (error) {
            testOutput.appendLine(`Test failed: ${error}`);
            throw error;
        }
    });
}); 