import * as vscode from 'vscode';
import * as jsonc from 'jsonc-parser';
import * as yaml from 'yaml';
import { getIndent } from './utils';

function sortObjectKeys(obj: any): any {
    if (obj === null || typeof obj !== 'object') {
        return obj;
    }

    if (Array.isArray(obj)) {
        return obj.map(sortObjectKeys);
    }

    const sortedKeys = Object.keys(obj).sort();
    const result: any = {};
    for (const key of sortedKeys) {
        result[key] = sortObjectKeys(obj[key]);
    }
    return result;
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
        } else if (languageId === 'properties' || languageId === 'env' || languageId === 'dotenv' || languageId === 'ignore') {
            return sortProperties(text);
        }
    } catch (e) {
        console.error('Error sorting text:', e);
    }
    return null;
}

function sortJson(text: string, indent: string): string {
    const parsed = jsonc.parse(text);
    if (parsed === undefined) return text;
    
    const sorted = sortObjectKeys(parsed);
    
    // For indent, try to determine if it's spaces or tabs
    let space: string | number = indent;
    if (indent.startsWith(' ')) {
        space = indent.length;
    }
    
    return JSON.stringify(sorted, null, space);
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
