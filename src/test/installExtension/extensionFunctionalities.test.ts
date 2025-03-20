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
    const workspaceUri: Uri = Uri.file(path.resolve(__dirname, '../../../src/test/navigation/workspace'));
    const libsPath: string = path.resolve(workspaceUri.fsPath, 'libs');

    setup(async function () {
        testOutput = createTestOutput();
        await setupTestEnvironment(testOutput);

    });

    teardown(async function () {
        await teardownTestEnvironment(testOutput);
        testOutput.dispose();
    });

    test('Code navigation functionality test', async function () {
        testOutput.appendLine('=================================== CODE NAVIGATION TEST STARTED ============================================');

        // Open model file
        const doc = await workspace.openTextDocument(modelUri);
        await window.showTextDocument(doc);

        // Test navigation to attribute in same file
        const attributeInSameFile = await commands.executeCommand(
            "vscode.executeDefinitionProvider",
            modelUri,
            new Position(17, 16)
        );
        const expectedAttributeLocation = new Range(new Position(6, 11), new Position(6, 15));
        assert.strictEqual((attributeInSameFile as Location[]).length, 1);
        assert.strictEqual(attributeInSameFile[0].uri.fsPath, modelUri.fsPath);
        assert.deepStrictEqual(attributeInSameFile[0].range, expectedAttributeLocation);

        // Test navigation to type in different file
        const typeInDifferentFile = await commands.executeCommand(
            "vscode.executeDefinitionProvider",
            modelUri,
            new Position(8, 18)
        );
        assert.strictEqual((typeInDifferentFile as Location[]).length, 1);
        assert.strictEqual(
            typeInDifferentFile[0].uri.fsPath,
            path.resolve(libsPath, "testmodule", "model", "_init.cf")
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
        assert.strictEqual(
            pluginLocation[0].uri.fsPath,
            path.resolve(libsPath, "testmodule", "plugins", "__init__.py")
        );
        assert.deepStrictEqual(
            pluginLocation[0].range,
            new Range(new Position(4, 4), new Position(4, 8))
        );
    });
});
