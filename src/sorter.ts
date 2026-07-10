import * as vscode from 'vscode';
import { parse as parseCommentJson, stringify as stringifyCommentJson, CommentArray, CommentObject } from 'comment-json';
import * as yaml from 'yaml';
import { getIndent } from './utils';

/// Recursively sorts the keys of a parsed comment-json object in-place (alphabetically).
/// Uses Object.getOwnPropertyNames to handle all keys and deletes+reinserts them
/// so comment-json's Symbol-based comment metadata follows correctly.
function sortObjectKeysInPlace(obj: CommentObject | CommentArray<unknown> | unknown): void {
    if (obj === null || typeof obj !== 'object') {
        return;
    }

    if (Array.isArray(obj)) {
        (obj as unknown[]).forEach(sortObjectKeysInPlace);
        return;
    }

    // Get all string keys and sort them
    const keys = Object.getOwnPropertyNames(obj).sort();
    for (const key of keys) {
        const val = (obj as Record<string, unknown>)[key];
        sortObjectKeysInPlace(val);
        delete (obj as Record<string, unknown>)[key];
        (obj as Record<string, unknown>)[key] = val;
    }
}

export function sortDocument(document: vscode.TextDocument): vscode.TextEdit[] {
    const text = document.getText();

    if (!text.trim()) {
        return [];
    }

    const sortedText = sortText(text, document.languageId, getIndent(document));

    if (sortedText !== null && sortedText !== text) {
        const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(text.length)
        );
        return [vscode.TextEdit.replace(fullRange, sortedText)];
    }
    return [];
}

export function sortSelection(document: vscode.TextDocument, selection: vscode.Selection): vscode.TextEdit[] {
    if (selection.isEmpty) {
        return [];
    }

    const text = document.getText(selection);

    if (!text.trim()) {
        return [];
    }

    const sortedText = sortText(text, document.languageId, getIndent(document));

    if (sortedText !== null && sortedText !== text) {
        return [vscode.TextEdit.replace(selection, sortedText)];
    }
    return [];
}

function sortText(text: string, languageId: string, indent: string): string | null {
    try {
        if (languageId === 'json' || languageId === 'jsonc') {
            return sortJson(text, indent);
        } else if (languageId === 'yaml') {
            return sortYaml(text, indent);
        } else if (languageId === 'properties' || languageId === 'env' || languageId === 'dotenv') {
            return sortProperties(text);
        } else if (languageId === 'ignore' || languageId === 'plaintext') {
            return sortLines(text);
        }
    } catch (e) {
        vscode.window.showErrorMessage(`Dyno Extension: Failed to sort — ${(e as Error).message}`);
        console.error('Error sorting text:', e);
    }
    return null;
}

function sortJson(text: string, indent: string): string {
    const space: string | number = indent.startsWith(' ') ? indent.length : indent;

    const parsed = parseCommentJson(text);
    if (parsed === undefined || parsed === null) {
        return text;
    }

    sortObjectKeysInPlace(parsed);
    return stringifyCommentJson(parsed, null, space) as string;
}

function sortYaml(text: string, indent: string): string {
    const doc = yaml.parseDocument(text);

    if (doc.errors.length > 0) {
        throw new Error(`YAML parse errors: ${doc.errors.map(e => e.message).join(', ')}`);
    }

    // Nothing to sort for null/empty documents
    if (doc.contents !== null) {
        sortYamlNode(doc.contents);
    }

    const indentWidth = indent.startsWith(' ') ? indent.length : 2;
    return doc.toString({ indent: indentWidth });
}

function sortYamlNode(node: yaml.Node | null): void {
    if (!node) {
        return;
    }
    if (yaml.isMap(node)) {
        node.items.sort((a, b) => {
            const keyA = yaml.isScalar(a.key) ? String(a.key.value ?? '') : '';
            const keyB = yaml.isScalar(b.key) ? String(b.key.value ?? '') : '';
            return keyA.localeCompare(keyB);
        });
        for (const item of node.items) {
            const val = item.value;
            if (yaml.isNode(val)) {
                sortYamlNode(val);
            }
        }
    } else if (yaml.isSeq(node)) {
        for (const item of node.items) {
            if (yaml.isNode(item)) {
                sortYamlNode(item);
            }
        }
    }
}

/// Sorts `.env` / `.properties` files while preserving comment and blank-line "blocks"
/// that belong to each key. Multi-line values (lines ending with `\`) are handled.
function sortProperties(text: string): string {
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);

    const blocks: { key: string; lines: string[] }[] = [];
    let currentLines: string[] = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];
        const match = line.match(/^\s*([a-zA-Z0-9_.-]+)\s*[:=]/);

        if (match) {
            // Collect value lines, including multiline continuations (ending with \)
            const keyLines: string[] = [line];
            while (keyLines[keyLines.length - 1].endsWith('\\') && i + 1 < lines.length) {
                i++;
                keyLines.push(lines[i]);
            }
            // Prepend any accumulated comment/blank lines
            blocks.push({ key: match[1], lines: [...currentLines, ...keyLines] });
            currentLines = [];
        } else {
            currentLines.push(line);
        }
        i++;
    }

    // Remaining lines after last key (e.g. trailing newline/comments)
    const footer = currentLines;

    blocks.sort((a, b) => a.key.localeCompare(b.key));

    const resultLines: string[] = [];
    for (const block of blocks) {
        resultLines.push(...block.lines);
    }
    resultLines.push(...footer);

    return resultLines.join(newline);
}

/// Sorts all lines alphabetically, keeping trailing empty lines at the end.
function sortLines(text: string): string {
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);

    // Peel off trailing empty lines so they stay at the bottom
    const trailingEmpties: string[] = [];
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
        trailingEmpties.unshift(lines.pop()!);
    }

    lines.sort((a, b) => a.localeCompare(b));
    return [...lines, ...trailingEmpties].join(newline);
}
