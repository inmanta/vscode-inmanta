import * as assert from 'assert';
import { after, before, describe, it, beforeEach } from 'mocha';
import * as path from 'path';

import { Uri, window, commands, workspace, TextDocument, TextEditor, extensions } from 'vscode';

const cfFile: Uri = Uri.file(path.resolve(__dirname, '../../../src/test/compile/workspace/valid.cf'));

describe('Load extension', () => {

    beforeEach(async function() {
        await commands.executeCommand('workbench.action.closeActiveEditor');
    });

    it('Load .cf file without opening a directory NO compilerVenv configured', async function() {
        await workspace.getConfiguration('inmanta').update('compilerVenv', "", true);
        // Verify initial state
        assert.ok(!extensions.getExtension('inmanta.inmanta').isActive);

        // Open a single file instead of a folder
        await commands.executeCommand('vscode.open', cfFile)
        const doc: TextDocument = await workspace.openTextDocument(cfFile);
        const edit: TextEditor = await window.showTextDocument(doc);

        // The extension will not start because it doesn't have a storageUri to store the compilerVenv.
        // A different storageUri is created for each workspace. If no workspace is opened, no
        // storageUri is available.
        assert.ok(!extensions.getExtension('inmanta.inmanta').isActive);
    });
});
