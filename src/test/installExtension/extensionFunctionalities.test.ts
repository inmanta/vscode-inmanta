import * as assert from 'assert';
import { suite, test } from 'mocha';
import { commands, workspace, Uri, Position, Location, Range, OutputChannel, window } from 'vscode';
import {
    modelUri,
    createTestOutput,
    setupTestEnvironment,
    teardownTestEnvironment,
} from './utils';
import * as path from 'path';

suite('Extension Functionalities Test', () => {
    let testOutput: OutputChannel;

    const workspaceUri: Uri = modelUri.with({ path: path.dirname(modelUri.fsPath) });
    const libsPath: string = path.resolve(workspaceUri.fsPath, 'libs');

    setup(async function () {
        testOutput = createTestOutput();
        await setupTestEnvironment(testOutput);
    });

    teardown(async function () {
        await teardownTestEnvironment(testOutput);
        testOutput.dispose();
    });

    test('Code functionality test', async function () {
        testOutput.appendLine('=================================== CODE NAVIGATION TEST STARTED ============================================');

        // Open model file 
        const doc = await workspace.openTextDocument(modelUri);
        await window.showTextDocument(doc);

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

        // Navigation to a non-existent symbol returns no location
        const nonExistentSymbol = await commands.executeCommand("vscode.executeDefinitionProvider", modelUri, new Position(20, 20));
        assert.strictEqual((nonExistentSymbol as Location[]).length, 0, "Non-existent symbol should return no locations");

        // Test hover functionality
        testOutput.appendLine('=================================== HOVER TEST STARTED ============================================');
        const docstringEntity = await commands.executeCommand("vscode.executeHoverProvider", modelUri, new Position(13, 11));

        const expectedDocstringEntity: string = `
\`\`\`inmanta
entity Person:
\`\`\`

___
A&nbsp;class&nbsp;to&nbsp;represent&nbsp;a&nbsp;person.`;
        assert.strictEqual(docstringEntity[0].contents[0].value, expectedDocstringEntity, "wrong docstring Entity");
    });
});
