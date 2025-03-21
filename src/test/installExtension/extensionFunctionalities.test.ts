import * as assert from 'assert';
import { suite, test } from 'mocha';
import { commands, workspace, Uri, Position, Location, Range, OutputChannel, window, Hover, MarkdownString } from 'vscode';
import {
    modelUri,
    createTestOutput,
    setupTestEnvironment,
    teardownTestEnvironment,
    waitForCompile,

} from './utils';
import * as path from 'path';
import * as fs from 'fs-extra';

suite('Extension Functionalities Test', () => {
    let testOutput: OutputChannel;
    const logPath: string = process.env.INMANTA_LS_LOG_PATH;
    const workspaceUri: Uri = modelUri.with({ path: path.dirname(modelUri.fsPath) });
    const libsPath: string = path.resolve(workspaceUri.fsPath, 'libs');

    setup(async function () {
        testOutput = createTestOutput();
        testOutput.appendLine(`Log path: ${logPath}`);
        testOutput.appendLine(`Checking if log directory exists...`);
        const logDir = path.dirname(logPath);

        try {
            await fs.ensureDir(logDir);
            testOutput.appendLine(`Log directory ${logDir} exists or was created`);

            await fs.writeFile(logPath, ""); // Clear log file before test
            testOutput.appendLine(`Successfully cleared/created log file at ${logPath}`);

            const stats = await fs.stat(logPath);
            testOutput.appendLine(`Log file permissions: ${stats.mode}`);
        } catch (error) {
            testOutput.appendLine(`Error with log file operations: ${error}`);
            throw error;
        }

        await setupTestEnvironment(testOutput);
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
        const succeeded = await waitForCompile(logPath, 25000);
        assert.strictEqual(succeeded, true, "Compilation didn't succeed");

        const attributeInSameFile = await commands.executeCommand("vscode.executeDefinitionProvider", modelUri, new Position(17, 16));
        const expectedAttributeLocation = new Range(new Position(6, 11), new Position(6, 15));
        assert.strictEqual((attributeInSameFile as Location[]).length, 1);
        assert.strictEqual(attributeInSameFile[0].uri.fsPath, modelUri.fsPath);
        assert.deepStrictEqual(attributeInSameFile[0].range, expectedAttributeLocation, "Attribute location in the same file doesn't match");

        const typeInDifferentFile = await commands.executeCommand("vscode.executeDefinitionProvider", modelUri, new Position(8, 18));
        assert.strictEqual((typeInDifferentFile as Location[]).length, 1);
        assert.strictEqual(typeInDifferentFile[0].uri.fsPath, path.resolve(libsPath, "testmodule", "model", "_init.cf"));
        assert.deepStrictEqual(typeInDifferentFile[0].range, new Range(new Position(0, 8), new Position(0, 11)), "Attribute location in different file doesn't match");

        const pluginLocation = await commands.executeCommand("vscode.executeDefinitionProvider", modelUri, new Position(21, 15));
        assert.strictEqual((pluginLocation as Location[]).length, 1);
        assert.strictEqual(pluginLocation[0].uri.fsPath, path.resolve(libsPath, "testmodule", "plugins", "__init__.py"));
        assert.deepStrictEqual(pluginLocation[0].range, new Range(new Position(4, 4), new Position(4, 8)), "Plugin location doesn't match");

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
