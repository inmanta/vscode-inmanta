import * as assert from 'assert';
import { suite, test, before, after } from 'mocha';
import { commands, workspace, languages, Position, Location, Hover, Uri, OutputChannel } from 'vscode';
import {
    modelUri,
    createTestOutput,
    setupTestEnvironment,
    teardownTestEnvironment
} from './utils';
import * as fs from 'fs-extra';
import * as path from 'path';

suite('Extension Functionalities Test', () => {
    let testOutput: OutputChannel;
    let testFilePath: string;
    let invalidFilePath: string;

    before(async function () {
        testOutput = createTestOutput();
        await setupTestEnvironment(testOutput);

        // Create a more complex test file for functionality testing
        testFilePath = path.join(workspace.workspaceFolders![0].uri.fsPath, 'test.cf');
        const testContent = `
entity Host:
    string name
    string os_type
end

entity WebServer extends Host:
    number port = 80
    bool ssl = false
end

implementation webServerConfig for WebServer:
    self.os_type = "linux"
end

WebServer(name="test-server", os_type="linux")
        `.trim();

        await fs.writeFile(testFilePath, testContent);
        await commands.executeCommand('vscode.open', Uri.file(testFilePath));

        // Create invalid file for error detection test
        invalidFilePath = path.join(workspace.workspaceFolders![0].uri.fsPath, 'invalid.cf');
        const invalidContent = `
entity InvalidTest:
    string name
    invalid_type field  # Invalid type
    number = 42        # Missing attribute name
end

InvalidTest(name=123)  # Wrong type for string attribute
        `.trim();

        await fs.writeFile(invalidFilePath, invalidContent);

        // Give the language server time to process the files
        await new Promise(resolve => setTimeout(resolve, 2000));
    });

    after(async function () {
        await teardownTestEnvironment(testOutput, []);
        // clean up the files we created
        await fs.unlink(testFilePath);
        await fs.unlink(invalidFilePath);
        await commands.executeCommand('workbench.action.closeAllEditors');
        testOutput.dispose();
    });

    test('Hover Provider - Shows correct information', async function () {
        testOutput.appendLine('=== TEST STARTED: HOVER PROVIDER ===');

        try {
            // Test hovering over entity name
            const hoverPosition = new Position(0, 8); // Position on "Host" entity
            const hoverResult = await commands.executeCommand<Hover[]>(
                'vscode.executeHoverProvider',
                Uri.file(testFilePath),
                hoverPosition
            );

            assert.ok(hoverResult && hoverResult.length > 0, 'Hover result should be available');
            assert.ok(hoverResult[0] instanceof Hover, 'Result should be a Hover instance');
            assert.ok(hoverResult[0].contents.length > 0, 'Hover should contain information');

            testOutput.appendLine('Hover provider test completed successfully');
        } catch (error) {
            testOutput.appendLine(`Hover provider test failed: ${error}`);
            throw error;
        }
    });

    test('Definition Provider - Navigates to correct location', async function () {
        testOutput.appendLine('=== TEST STARTED: DEFINITION PROVIDER ===');

        try {
            // Test go to definition on entity usage
            const definitionPosition = new Position(11, 0); // Position on "WebServer" usage
            const definition = await commands.executeCommand<Location[]>(
                'vscode.executeDefinitionProvider',
                Uri.file(testFilePath),
                definitionPosition
            );

            assert.ok(definition && definition.length > 0, 'Definition should be found');
            assert.strictEqual(definition[0].range.start.line, 4, 'Definition should point to WebServer entity declaration');

            testOutput.appendLine('Definition provider test completed successfully');
        } catch (error) {
            testOutput.appendLine(`Definition provider test failed: ${error}`);
            throw error;
        }
    });

    test('References Provider - Lists all correct references', async function () {
        testOutput.appendLine('=== TEST STARTED: REFERENCES PROVIDER ===');

        try {
            // Test find all references for 'os_type' attribute
            const referencesPosition = new Position(2, 12); // Position on "os_type" in Host entity
            const references = await commands.executeCommand<Location[]>(
                'vscode.executeReferenceProvider',
                Uri.file(testFilePath),
                referencesPosition
            );

            assert.ok(references && references.length >= 2, 'Should find at least 2 references to os_type');

            // References should include declaration and usage
            const referenceLines = references.map(ref => ref.range.start.line);
            assert.ok(referenceLines.includes(2), 'Should include declaration');
            assert.ok(referenceLines.includes(9), 'Should include usage in implementation');

            testOutput.appendLine('References provider test completed successfully');
        } catch (error) {
            testOutput.appendLine(`References provider test failed: ${error}`);
            throw error;
        }
    });

    test('Error Detection - Highlights invalid code', async function () {
        testOutput.appendLine('=== TEST STARTED: ERROR DETECTION ===');

        try {
            // Open the invalid file
            await commands.executeCommand('vscode.open', Uri.file(invalidFilePath));

            // Give the language server time to process the file and report diagnostics
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Get diagnostics for the file
            const diagnostics = languages.getDiagnostics(Uri.file(invalidFilePath));
            assert.ok(diagnostics && diagnostics.length > 0, 'Should have diagnostics for invalid code');

            // Verify specific error conditions
            const diagnosticMessages = diagnostics.map(d => d.message.toLowerCase());
            assert.ok(
                diagnosticMessages.some(msg => msg.includes('type') || msg.includes('invalid_type')),
                'Should detect invalid type'
            );
            assert.ok(
                diagnosticMessages.some(msg => msg.includes('attribute') || msg.includes('name')),
                'Should detect missing attribute name'
            );
            assert.ok(
                diagnosticMessages.some(msg => msg.includes('string') || msg.includes('type')),
                'Should detect type mismatch in constructor'
            );

            testOutput.appendLine('Error detection test completed successfully');
        } catch (error) {
            testOutput.appendLine(`Error detection test failed: ${error}`);
            throw error;
        }
    });
});
