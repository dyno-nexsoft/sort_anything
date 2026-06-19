import * as vscode from 'vscode';
import { sortDocument, sortSelection } from './sorter';

export function activate(context: vscode.ExtensionContext) {
    console.log('Extension "sort-anything" is now active!');

    const sortDocumentDisposable = vscode.commands.registerTextEditorCommand(
        'sortAnything.sortDocument',
        (textEditor, edit) => {
            const edits = sortDocument(textEditor.document);
            for (const textEdit of edits) {
                edit.replace(textEdit.range, textEdit.newText);
            }
        }
    );

    const sortSelectionDisposable = vscode.commands.registerTextEditorCommand(
        'sortAnything.sortSelection',
        (textEditor, edit) => {
            const edits = sortSelection(textEditor.document, textEditor.selection);
            for (const textEdit of edits) {
                edit.replace(textEdit.range, textEdit.newText);
            }
        }
    );

    context.subscriptions.push(sortDocumentDisposable, sortSelectionDisposable);
}

export function deactivate() {}
