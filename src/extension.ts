import * as vscode from 'vscode';
import { sortDocument, sortSelection } from './sorter';

export function activate(context: vscode.ExtensionContext) {
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

    context.subscriptions.push(sortDocumentDisposable, sortSelectionDisposable);
}

export function deactivate() {}
