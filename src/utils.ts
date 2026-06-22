import * as vscode from 'vscode';

/// Gets the indentation string (spaces or tab) for the given document,
/// based on the active editor options or by analyzing the document text.
export function getIndent(document: vscode.TextDocument): string {
    // Find any editor with this document open, not just the active one
    const editor = vscode.window.visibleTextEditors.find(e => e.document === document)
        ?? vscode.window.activeTextEditor;

    if (editor && editor.document.uri.toString() === document.uri.toString()) {
        const options = editor.options;
        if (options.insertSpaces) {
            return ' '.repeat((options.tabSize as number) || 2);
        }
        return '\t';
    }

    // Fallback: analyze first indented line
    const text = document.getText();
    const match = text.match(/^([ \t]+)/m);
    if (match) {
        // Normalize: if tabs used return tab, else return detected spaces
        return match[1].includes('\t') ? '\t' : match[1];
    }
    return '  '; // Default to 2 spaces
}
