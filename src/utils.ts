import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel | undefined;

function getOutputChannel(): vscode.OutputChannel {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('Dyno Extension');
    }
    return outputChannel;
}

export function logError(error: unknown, contextMessage?: string): void {
    const channel = getOutputChannel();
    const now = new Date().toISOString();
    channel.appendLine(`[${now}] ERROR: ${contextMessage || ''}`);
    if (error instanceof Error) {
        channel.appendLine(`Message: ${error.message}`);
        if (error.stack) {
            channel.appendLine(`Stack: ${error.stack}`);
        }
    } else {
        channel.appendLine(`Details: ${JSON.stringify(error)}`);
    }
    channel.appendLine('----------------------------------------------------');
    // Bật panel output lên để user thấy ngay
    channel.show(true);
}

export function logInfo(message: string): void {
    const channel = getOutputChannel();
    const now = new Date().toISOString();
    channel.appendLine(`[${now}] INFO: ${message}`);
}

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
