import * as vscode from 'vscode';

export function getIndent(document: vscode.TextDocument): string {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document === document) {
        const options = editor.options;
        if (options.insertSpaces) {
            return ' '.repeat((options.tabSize as number) || 2);
        }
        return '\t';
    }
    
    // Fallback: analyze text
    const text = document.getText();
    const match = text.match(/^[\t ]+/m);
    if (match) {
        return match[0];
    }
    return '  ';
}
