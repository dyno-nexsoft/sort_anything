import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';

/// Checks whether a `.dart` file is a `part of` file by scanning its first few lines.
/// Such files cannot be independently exported.
async function isPartOfFile(filePath: string): Promise<boolean> {
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        // Only scan first 50 lines for performance
        const lines = content.split('\n').slice(0, 50);
        return lines.some(line => /^\s*part\s+of\s+/.test(line));
    } catch {
        return false;
    }
}

/// Recursively collects all `.dart` files under `dirPath`.
/// Returns paths relative to `rootDir`.
async function collectDartFiles(dirPath: string, rootDir: string): Promise<string[]> {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const results: string[] = [];

    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
            // Recurse into subdirectory
            const subFiles = await collectDartFiles(fullPath, rootDir);
            results.push(...subFiles);
        } else if (entry.isFile() && entry.name.endsWith('.dart')) {
            results.push(fullPath);
        }
    }

    return results;
}

/// Generates a Dart barrel file for the given folder URI.
/// The barrel file is named `<folderName>.dart` and contains sorted `export` statements
/// for all non-`part of` Dart files within the folder (recursively).
export async function generateBarrelFile(folderUri: vscode.Uri): Promise<void> {
    const folderPath = folderUri.fsPath;
    const folderName = path.basename(folderPath);
    const barrelFileName = `${folderName}.dart`;
    const barrelFilePath = path.join(folderPath, barrelFileName);

    // Collect all dart files recursively
    let allDartFiles: string[];
    try {
        allDartFiles = await collectDartFiles(folderPath, folderPath);
    } catch (e) {
        throw new Error(`Could not read folder: ${(e as Error).message}`);
    }

    // Filter out the barrel file itself and `part of` files
    const exportablePaths: string[] = [];

    for (const filePath of allDartFiles) {
        // Skip the barrel file itself
        if (path.normalize(filePath) === path.normalize(barrelFilePath)) {
            continue;
        }
        // Skip `part of` files
        if (await isPartOfFile(filePath)) {
            continue;
        }
        exportablePaths.push(filePath);
    }

    if (exportablePaths.length === 0) {
        vscode.window.showWarningMessage(
            `Sort Anything: No exportable Dart files found in "${folderName}".`
        );
        return;
    }

    // Convert absolute paths to relative export paths (forward slashes)
    const exportLines = exportablePaths
        .map(filePath => {
            const relativePath = path.relative(folderPath, filePath).replace(/\\/g, '/');
            return `export '${relativePath}';`;
        })
        .sort((a, b) => a.localeCompare(b));

    // Build file content with a header comment
    const content = [
        `// GENERATED FILE — do not edit by hand.`,
        `// Run "Generate Dart Barrel File" to regenerate.`,
        ``,
        ...exportLines,
        ``, // trailing newline
    ].join('\n');

    await fs.writeFile(barrelFilePath, content, 'utf-8');

    // Open the generated file
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(barrelFilePath));
    await vscode.window.showTextDocument(doc);

    vscode.window.setStatusBarMessage(
        `$(check) Sort Anything: Barrel file "${barrelFileName}" generated with ${exportLines.length} export(s).`,
        4000
    );
}
