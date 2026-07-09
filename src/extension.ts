import * as vscode from 'vscode';
import { sortDocument, sortSelection } from './sorter';
import { generateBarrelFile } from './barrelGenerator';
import { generateCommitMessage } from './commitGenerator';
import { logInfo } from './utils';

export function activate(context: vscode.ExtensionContext) {
    logInfo('Sort Anything extension activated successfully.');
    const sortDocumentDisposable = vscode.commands.registerTextEditorCommand(
        'sortAnything.sortDocument',
        (textEditor, edit) => {
            const edits = sortDocument(textEditor.document);
            if (edits.length === 0) {
                vscode.window.setStatusBarMessage('$(check) Sort Anything: Already sorted or nothing to sort.', 3000);
                return;
            }
            for (const textEdit of edits) {
                edit.replace(textEdit.range, textEdit.newText);
            }
            vscode.window.setStatusBarMessage('$(check) Sort Anything: Document sorted!', 3000);
        }
    );

    const sortSelectionDisposable = vscode.commands.registerTextEditorCommand(
        'sortAnything.sortSelection',
        (textEditor, edit) => {
            const edits = sortSelection(textEditor.document, textEditor.selection);
            if (edits.length === 0) {
                vscode.window.setStatusBarMessage('$(check) Sort Anything: Already sorted or nothing to sort.', 3000);
                return;
            }
            for (const textEdit of edits) {
                edit.replace(textEdit.range, textEdit.newText);
            }
            vscode.window.setStatusBarMessage('$(check) Sort Anything: Selection sorted!', 3000);
        }
    );

    const generateBarrelDisposable = vscode.commands.registerCommand(
        'sortAnything.generateDartBarrel',
        async (folderUri: vscode.Uri) => {
            // Fallback: use the workspace folder if called from command palette
            const targetUri = folderUri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
            if (!targetUri) {
                vscode.window.showErrorMessage('Sort Anything: No folder selected.');
                return;
            }
            try {
                await generateBarrelFile(targetUri);
            } catch (e) {
                vscode.window.showErrorMessage(`Sort Anything: ${(e as Error).message}`);
            }
        }
    );

    const generateCommitDisposable = vscode.commands.registerCommand(
        'sortAnything.generateCommitMessage',
        async () => {
            await generateCommitMessage();
        }
    );

    context.subscriptions.push(
        sortDocumentDisposable,
        sortSelectionDisposable,
        generateBarrelDisposable,
        generateCommitDisposable
    );
}

export function deactivate() {}
