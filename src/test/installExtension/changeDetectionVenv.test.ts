import * as assert from 'assert';
import { suite, test, setup, teardown } from 'mocha';
import { commands, workspace, OutputChannel, extensions } from 'vscode';
import {
    modelUri,
    createTestOutput,
    isLanguageServerInstalled,
    isLanguageServerRunning,
    assertWithTimeout,
    createVirtualEnv,
    setupTestEnvironment,
    teardownTestEnvironment
} from './utils';

suite('Language Server Venv Change Detection', () => {
    let testOutput: OutputChannel;

    setup(async function () {
        testOutput = createTestOutput();
        await setupTestEnvironment(testOutput);
    });

    teardown(async function () {
        await teardownTestEnvironment(testOutput, ['.venv2']);
        testOutput.dispose();
    });

    // Add a simple test to verify the environment before running the main test
    test('Environment check - Inmanta extension is available', async function () {
        try {
            testOutput.appendLine('=================================== ENVIRONMENT CHECK STARTED ============================================');
            testOutput.appendLine(`Test running at: ${new Date().toISOString()}`);

            // List all extensions
            testOutput.appendLine('Listing all available extensions:');
            const allExtensions = extensions.all;
            for (const ext of allExtensions) {
                testOutput.appendLine(`- ${ext.id} (${ext.isActive ? 'active' : 'inactive'})`);
            }

            // Check if Inmanta extension is available
            testOutput.appendLine('\nChecking if Inmanta extension is available...');
            const inmantaExtension = extensions.getExtension('inmanta.inmanta');

            if (inmantaExtension) {
                testOutput.appendLine('Inmanta extension is available');

                // Try to activate the extension if it's not already active
                if (!inmantaExtension.isActive) {
                    testOutput.appendLine('Inmanta extension is not active, attempting to activate...');
                    try {
                        await inmantaExtension.activate();
                        testOutput.appendLine('Inmanta extension activated successfully');
                    } catch (activationError) {
                        testOutput.appendLine(`WARNING: Failed to activate Inmanta extension: ${activationError}`);
                        // Continue with diagnostics even if activation fails
                    }
                } else {
                    testOutput.appendLine('Inmanta extension is already active');
                }

                testOutput.appendLine(`Inmanta extension activation state: ${inmantaExtension.isActive ? 'active' : 'inactive'}`);

                // Check extension exports
                testOutput.appendLine('Checking Inmanta extension exports:');
                const exports = inmantaExtension.exports;
                if (exports) {
                    testOutput.appendLine(`Extension exports: ${JSON.stringify(Object.keys(exports))}`);
                } else {
                    testOutput.appendLine('No exports found in Inmanta extension');
                }
            } else {
                testOutput.appendLine('WARNING: Inmanta extension is NOT available');
            }

            // Check available commands
            testOutput.appendLine('\nChecking available commands:');
            const allCommands = await commands.getCommands();
            const inmantaCommands = allCommands.filter(cmd => cmd.startsWith('inmanta.'));

            if (inmantaCommands.length > 0) {
                testOutput.appendLine(`Found ${inmantaCommands.length} Inmanta commands: ${inmantaCommands.join(', ')}`);

                if (allCommands.includes('inmanta.installLS')) {
                    testOutput.appendLine('inmanta.installLS command is available');
                } else {
                    testOutput.appendLine('WARNING: inmanta.installLS command is NOT available');
                }
            } else {
                testOutput.appendLine('WARNING: No Inmanta commands found');
            }

            // Check workspace settings
            testOutput.appendLine('Checking workspace settings:');
            const inmantaSettings = workspace.getConfiguration('inmanta');
            testOutput.appendLine(`Inmanta settings: ${JSON.stringify(inmantaSettings)}`);

            testOutput.appendLine('=================================== ENVIRONMENT CHECK COMPLETED ============================================');
        } catch (error) {
            testOutput.appendLine(`Environment check error: ${error}`);
            testOutput.appendLine(`Stack trace: ${error.stack}`);
            // Don't throw here, just log the error
        }
    });

    test('Should detect if we change venv and no server is installed', async function () {
        testOutput.appendLine('=================================== TEST STARTED: Should detect if we change venv and no server is installed ============================================');

        // Create a second virtual environment
        testOutput.appendLine('Creating second virtual environment...');
        const pythonPath2 = await createVirtualEnv(".venv2");
        testOutput.appendLine(`Created second virtual environment at: ${pythonPath2}`);

        // Configure Python interpreter directly (skip interactive selection)
        testOutput.appendLine('Configuring Python interpreter programmatically for new venv');

        // Update both workspace and global settings
        await workspace.getConfiguration('python').update('defaultInterpreterPath', pythonPath2, true); // global
        await workspace.getConfiguration('python').update('defaultInterpreterPath', pythonPath2, false); // workspace
        testOutput.appendLine('Updated Python interpreter path to new venv');

        // Wait for Python extension to recognize the new interpreter
        testOutput.appendLine('Waiting for Python extension to recognize the new interpreter...');
        await assertWithTimeout(
            async () => {
                const config = workspace.getConfiguration('python');
                const currentPath = config.get('defaultInterpreterPath');
                testOutput.appendLine(`Current interpreter path: ${currentPath}`);
                assert.strictEqual(currentPath, pythonPath2, 'Python interpreter should be set to the new venv');
            },
            5000, // Increased timeout
            'Python interpreter was not properly configured within 5 seconds'
        );
        testOutput.appendLine('Python interpreter successfully changed');

        // Go back to the .cf file to ensure we're in the right context
        testOutput.appendLine('Opening .cf file...');
        await commands.executeCommand('workbench.action.closeAllEditors');
        await commands.executeCommand('vscode.open', modelUri);
        testOutput.appendLine('.cf file opened');

        // give the editor a moment to trigger restart of the language server
        testOutput.appendLine('Waiting for language server to restart...');
        await new Promise(resolve => setTimeout(resolve, 5000)); // Increased wait time
        testOutput.appendLine('Continuing after wait...');

        // Wait a bit for the warning to appear
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Check if the language server is installed in the new venv
        testOutput.appendLine('Checking if language server is installed in the new venv...');
        const isInstalled = await isLanguageServerInstalled(pythonPath2);
        testOutput.appendLine(`Language server installed: ${isInstalled}`);
        assert.strictEqual(isInstalled, false, 'Language server should not be installed in the new venv');

        // Check if the language server is running
        testOutput.appendLine('Checking if language server is running...');
        const isRunning = await isLanguageServerRunning();
        testOutput.appendLine(`Language server running: ${isRunning}`);
        assert.strictEqual(isRunning, false, 'Language server should not be running after venv change');

        testOutput.appendLine('=================================== TEST COMPLETED SUCCESSFULLY ============================================');
    });
}); 