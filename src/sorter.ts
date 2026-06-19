import * as vscode from 'vscode';
import { parse as parseCommentJson, stringify as stringifyCommentJson } from 'comment-json';
import * as yaml from 'yaml';
import { getIndent } from './utils';

function sortObjectKeysInPlace(obj: any) {
    if (obj === null || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
        obj.forEach(sortObjectKeysInPlace);
        return;
    }

    const keys = Object.keys(obj).sort();
    for (const key of keys) {
        const val = obj[key];
        sortObjectKeysInPlace(val);
        delete obj[key];
        obj[key] = val; // Re-insert to change order while preserving comments
    }
}

export function sortDocument(document: vscode.TextDocument): vscode.TextEdit[] {
    const text = document.getText();
    const sortedText = sortText(text, document.languageId, getIndent(document));
    
    if (sortedText && sortedText !== text) {
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
    const sortedText = sortText(text, document.languageId, getIndent(document));
    
    if (sortedText && sortedText !== text) {
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
        console.error('Error sorting text:', e);
    }
    return null;
}

function sortJson(text: string, indent: string): string {
    let space: string | number = indent;
    if (indent.startsWith(' ')) {
        space = indent.length;
    }

    try {
        const parsed = parseCommentJson(text);
        if (parsed === undefined) return text;
        
        sortObjectKeysInPlace(parsed);
        return stringifyCommentJson(parsed, null, space) as string;
    } catch (e) {
        console.error('JSON Parse error', e);
        return text;
    }
}

function sortYaml(text: string, indent: string): string {
    const doc = yaml.parseDocument(text);
    if (doc.errors.length > 0) {
        console.error('YAML parse errors:', doc.errors);
        return text;
    }
    
    sortYamlNode(doc.contents);
    
    let indentWidth = 2;
    if (indent.startsWith(' ')) {
        indentWidth = indent.length;
    }
    
    return doc.toString({ indent: indentWidth });
}

function sortYamlNode(node: any) {
    if (yaml.isMap(node)) {
        node.items.sort((a: any, b: any) => {
            const keyA = String(a.key?.value || '');
            const keyB = String(b.key?.value || '');
            return keyA.localeCompare(keyB);
        });
        for (const item of node.items) {
            sortYamlNode(item.value);
        }
    } else if (yaml.isSeq(node)) {
        for (const item of node.items) {
            sortYamlNode(item);
        }
    }
}

function sortProperties(text: string): string {
    const lines = text.split(/\r?\n/);
    const blocks: { key: string, lines: string[] }[] = [];
    
    let currentLines: string[] = [];
    
    for (const line of lines) {
        const match = line.match(/^\s*([a-zA-Z0-9_.-]+)\s*[:=]/);
        if (match) {
            const key = match[1];
            currentLines.push(line);
            blocks.push({ key, lines: currentLines });
            currentLines = [];
        } else {
            currentLines.push(line);
        }
    }
    
    const footer = currentLines;
    blocks.sort((a, b) => a.key.localeCompare(b.key));
    
    let resultLines: string[] = [];
    for (const block of blocks) {
        resultLines.push(...block.lines);
    }
    resultLines.push(...footer);
    
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    return resultLines.join(newline);
}

function sortLines(text: string): string {
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    lines.sort((a, b) => a.localeCompare(b));
    return lines.join(newline);
}
