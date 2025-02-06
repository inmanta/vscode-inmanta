import * as assert from 'assert';
import { describe, it, beforeEach } from 'mocha';
import * as path from 'path';

import { Uri, window, commands, workspace, TextDocument, extensions } from 'vscode';

const workspaceUri: Uri = Uri.file(path.resolve(__dirname, '../../../src/test/loadExtension/workspace'));
const cfFile: Uri = Uri.file(path.resolve(workspaceUri.fsPath, 'main.cf'));
const textFile: Uri = Uri.file(path.resolve(workspaceUri.fsPath, 'textFile.txt'));

describe('Load extension', () => {

    beforeEach(async function () {
        await commands.executeCommand('workbench.action.closeActiveEditor');
    });

    it('Load .txt file will not start the Extension', async function () {
        // Verify initial state
        let inmanta = extensions.getExtension('inmanta.inmanta');
        assert.ok(!inmanta.isActive, 'Inmanta extension is not started');

        // Open a single file instead of a folder
        await commands.executeCommand('vscode.open', textFile);
        const doc: TextDocument = await workspace.openTextDocument(textFile);
        await window.showTextDocument(doc);
        inmanta = extensions.getExtension('inmanta.inmanta');
        assert.ok(!inmanta.isActive, 'Inmanta extension is not started');
    });

    it('Load .cf file will start the Extension', async function () {
        await workspace.getConfiguration('inmanta').update('compilerVenv', "", true);
        // Verify initial state
        let inmanta = extensions.getExtension('inmanta.inmanta');
        assert.ok(!inmanta.isActive, 'Inmanta extension is not started');

        // Open a single file instead of a folder
        await commands.executeCommand('vscode.open', cfFile);
        const doc: TextDocument = await workspace.openTextDocument(cfFile);
        await window.showTextDocument(doc);
        inmanta = extensions.getExtension('inmanta.inmanta');
        assert.ok(inmanta.isActive, 'Inmanta extension is started');
    });
});
