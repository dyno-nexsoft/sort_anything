import * as vscode from 'vscode';
import { sortDocument, sortSelection } from './sorter';
import { generateBarrelFile } from './barrelGenerator';
import { generateCommitMessage, changeAiProvider } from './commitGenerator';
import { openClaudeMonitor } from './claudeMonitor';
import { installMonitorHook, uninstallMonitorHook } from './monitorHook';
import { logInfo } from './utils';

export function activate(context: vscode.ExtensionContext) {
    logInfo('Dyno Extension activated successfully.');
    const sortDocumentDisposable = vscode.commands.registerTextEditorCommand(
        'dynoExtension.sortDocument',
        (textEditor, edit) => {
            const edits = sortDocument(textEditor.document);
            if (edits.length === 0) {
                vscode.window.setStatusBarMessage('$(check) Dyno Extension: Already sorted or nothing to sort.', 3000);
                return;
            }
            for (const textEdit of edits) {
                edit.replace(textEdit.range, textEdit.newText);
            }
            vscode.window.setStatusBarMessage('$(check) Dyno Extension: Document sorted!', 3000);
        }
    );

    const sortSelectionDisposable = vscode.commands.registerTextEditorCommand(
        'dynoExtension.sortSelection',
        (textEditor, edit) => {
            const edits = sortSelection(textEditor.document, textEditor.selection);
            if (edits.length === 0) {
                vscode.window.setStatusBarMessage('$(check) Dyno Extension: Already sorted or nothing to sort.', 3000);
                return;
            }
            for (const textEdit of edits) {
                edit.replace(textEdit.range, textEdit.newText);
            }
            vscode.window.setStatusBarMessage('$(check) Dyno Extension: Selection sorted!', 3000);
        }
    );

    const generateBarrelDisposable = vscode.commands.registerCommand(
        'dynoExtension.generateDartBarrel',
        async (folderUri: vscode.Uri) => {
            // Fallback: use the workspace folder if called from command palette
            const targetUri = folderUri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
            if (!targetUri) {
                vscode.window.showErrorMessage('Dyno Extension: No folder selected.');
                return;
            }
            try {
                await generateBarrelFile(targetUri);
            } catch (e) {
                vscode.window.showErrorMessage(`Dyno Extension: ${(e as Error).message}`);
            }
        }
    );

    const generateCommitDisposable = vscode.commands.registerCommand(
        'dynoExtension.generateCommitMessage',
        async (scm?: any) => {
            await generateCommitMessage(context, scm);
        }
    );

    const changeAiProviderDisposable = vscode.commands.registerCommand(
        'dynoExtension.changeAiProvider',
        async () => {
            await changeAiProvider(context);
        }
    );

    const claudeMonitorDisposable = vscode.commands.registerCommand(
        'dynoExtension.showClaudeMonitor',
        () => openClaudeMonitor(context)
    );

    const installHookDisposable = vscode.commands.registerCommand(
        'dynoExtension.installClaudeMonitorHook',
        async () => {
            const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!cwd) { vscode.window.showErrorMessage('Claude Monitor: No workspace folder open.'); return; }
            try {
                const msg = await installMonitorHook(cwd);
                vscode.window.showInformationMessage(`Claude Monitor: ${msg}`);
            } catch (e) {
                vscode.window.showErrorMessage(`Claude Monitor: ${(e as Error).message}`);
            }
        }
    );

    const uninstallHookDisposable = vscode.commands.registerCommand(
        'dynoExtension.uninstallClaudeMonitorHook',
        async () => {
            const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!cwd) { vscode.window.showErrorMessage('Claude Monitor: No workspace folder open.'); return; }
            try {
                const msg = await uninstallMonitorHook(cwd);
                vscode.window.showInformationMessage(`Claude Monitor: ${msg}`);
            } catch (e) {
                vscode.window.showErrorMessage(`Claude Monitor: ${(e as Error).message}`);
            }
        }
    );

    context.subscriptions.push(
        sortDocumentDisposable,
        sortSelectionDisposable,
        generateBarrelDisposable,
        generateCommitDisposable,
        changeAiProviderDisposable,
        claudeMonitorDisposable,
        installHookDisposable,
        uninstallHookDisposable
    );
}

export function deactivate() {}
