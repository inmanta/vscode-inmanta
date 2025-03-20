import * as assert from 'assert';
import { suite, test } from 'mocha';
import { commands, workspace, Uri, Position, Location, Range, OutputChannel, window, Hover, MarkdownString } from 'vscode';
import {
    modelUri,
    createTestOutput,
    setupTestEnvironment,
    teardownTestEnvironment,
} from './utils';
import * as path from 'path';
import * as fs from 'fs-extra';

suite('Extension Functionalities Test', () => {
    let testOutput: OutputChannel;
    const logPath: string = process.env.INMANTA_LS_LOG_PATH || '/tmp/vscode-inmanta.log';
    const workspaceUri: Uri = modelUri.with({ path: path.dirname(modelUri.fsPath) });
    const libsPath: string = path.resolve(workspaceUri.fsPath, 'libs');

    setup(async function () {
        testOutput = createTestOutput();
        await setupTestEnvironment(testOutput);
        await fs.writeFile(logPath, ""); // Clear log file before test
    });

    teardown(async function () {
        await teardownTestEnvironment(testOutput);
        testOutput.dispose();
        await fs.writeFile(logPath, ""); // Clear log file after test
    });

    test('Code functionality test', async function () {
        testOutput.appendLine('=================================== CODE NAVIGATION TEST STARTED ============================================');

        // Open model file 
        const doc = await workspace.openTextDocument(modelUri);
        await window.showTextDocument(doc);

        // Test navigation to attribute in same file
        testOutput.appendLine('Executing definition provider command...');
        const attributeInSameFile = await commands.executeCommand<Location[]>(
            "vscode.executeDefinitionProvider",
            modelUri,
            new Position(17, 16)
        );
        testOutput.appendLine(`Definition provider result: ${JSON.stringify(attributeInSameFile)}`);
        testOutput.appendLine(`Definition provider result type: ${typeof attributeInSameFile}`);
        testOutput.appendLine(`Is array: ${Array.isArray(attributeInSameFile)}`);
        testOutput.appendLine(`Result length: ${attributeInSameFile ? attributeInSameFile.length : 'undefined'}`);

        const expectedAttributeLocation = new Range(new Position(6, 11), new Position(6, 15));

        // Ensure we have results before proceeding
        if (!attributeInSameFile || attributeInSameFile.length === 0) {
            testOutput.appendLine('WARNING: No definition results returned');
            testOutput.appendLine(`Current document text: ${doc.getText()}`);
            testOutput.appendLine(`Trying to find definition at position line ${17}, character ${16}`);
        }

        assert.ok(attributeInSameFile, 'Definition provider should return a result');
        assert.ok(Array.isArray(attributeInSameFile), 'Definition provider should return an array');
        assert.strictEqual(attributeInSameFile.length, 1, 'Definition provider should return exactly one location');

        // Debug logging
        testOutput.appendLine(`Raw actual path: ${attributeInSameFile[0].uri.fsPath}`);
        testOutput.appendLine(`Raw expected path: ${modelUri.fsPath}`);
        testOutput.appendLine(`Workspace URI path: ${workspaceUri.fsPath}`);

        // Check if the paths point to the same file by checking the basename
        const actualBasename = path.basename(attributeInSameFile[0].uri.fsPath);
        const expectedBasename = path.basename(modelUri.fsPath);
        assert.strictEqual(actualBasename, expectedBasename, 'File names should match');

        assert.deepStrictEqual(attributeInSameFile[0].range, expectedAttributeLocation);

        // Test navigation to type in different file
        const typeInDifferentFile = await commands.executeCommand(
            "vscode.executeDefinitionProvider",
            modelUri,
            new Position(8, 18)
        );
        assert.strictEqual((typeInDifferentFile as Location[]).length, 1);

        const expectedTypePath = path.resolve(libsPath, "testmodule", "model", "_init.cf");
        assert.strictEqual(
            path.basename(typeInDifferentFile[0].uri.fsPath),
            path.basename(expectedTypePath),
            'Type definition file names should match'
        );
        assert.deepStrictEqual(
            typeInDifferentFile[0].range,
            new Range(new Position(0, 8), new Position(0, 11))
        );

        // Test navigation to plugin
        const pluginLocation = await commands.executeCommand(
            "vscode.executeDefinitionProvider",
            modelUri,
            new Position(21, 15)
        );
        assert.strictEqual((pluginLocation as Location[]).length, 1);

        const expectedPluginPath = path.resolve(libsPath, "testmodule", "plugins", "__init__.py");
        assert.strictEqual(
            path.basename(pluginLocation[0].uri.fsPath),
            path.basename(expectedPluginPath),
            'Plugin file names should match'
        );
        assert.deepStrictEqual(
            pluginLocation[0].range,
            new Range(new Position(4, 4), new Position(4, 8))
        );

        // Test hover functionality
        testOutput.appendLine('=================================== HOVER TEST STARTED ============================================');
        const hover = await commands.executeCommand(
            "vscode.executeHoverProvider",
            modelUri,
            new Position(17, 16)
        );
        testOutput.appendLine(`Hover result: ${JSON.stringify(hover)}`);
        assert.strictEqual((hover as Hover[]).length, 1);
        const hoverContents = (hover as Hover[])[0].contents;
        testOutput.appendLine(`Hover contents: ${JSON.stringify(hoverContents)}`);
        assert.strictEqual(hoverContents.length, 1);
        const content = hoverContents[0];
        testOutput.appendLine(`Content type: ${typeof content}, value: ${JSON.stringify(content)}`);
        assert.ok(content instanceof MarkdownString || typeof content === 'string', 'Hover content should be MarkdownString or string');
        const contentValue = content instanceof MarkdownString ? content.value : content;
        assert.ok(contentValue && contentValue.length > 0, 'Hover content should not be empty');
    });
});
