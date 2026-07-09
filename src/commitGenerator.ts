import * as vscode from 'vscode';
import { execSync } from 'child_process';
import { logError, logInfo } from './utils';

// ---------------------------------------------------------------------------
// Git diff helper
// ---------------------------------------------------------------------------

function getWorkspaceRoot(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        throw new Error('Workspace not found. Please open a folder/project first.');
    }
    return folders[0].uri.fsPath;
}

function getGitDiff(): string {
    const cwd = getWorkspaceRoot();
    try {
        const diff = execSync('git diff --staged', { cwd, encoding: 'utf-8' });
        return diff.trim();
    } catch (err) {
        throw new Error('Failed to run git. Make sure git is installed and this folder is a git repository.');
    }
}

// ---------------------------------------------------------------------------
// Prompt Builder
// ---------------------------------------------------------------------------

function buildPrompt(diff: string): string {
    return `You are a senior software engineer. Based on the following git diff, write a concise and professional commit message following Conventional Commits format (e.g., feat:, fix:, refactor:, chore:, docs:, style:, test:, build:, ci:, perf:).

Rules:
- Output ONLY the raw commit message text, nothing else. Do not wrap in quotes, backticks, or code blocks.
- Use imperative mood (e.g., "add", "fix", "update" — not "added", "fixed", "updates").
- Keep the subject line (first line) under 72 characters.
- Write a SINGLE-LINE message for simple, small, or single-topic changes (e.g., "docs: update README").
- Use a MULTI-LINE message (short subject line + blank line + bulleted body) ONLY for large, complex changes with multiple distinct tasks.
- Keep it natural, clean, and developer-friendly. Avoid repeating obvious file names in bullet points if it's already clear.

Git diff:
\`\`\`
${diff}
\`\`\``;
}

// ---------------------------------------------------------------------------
// Gemini provider
// ---------------------------------------------------------------------------

interface GeminiModelItem {
    name: string;
    displayName: string;
    description: string;
    supportedGenerationMethods: string[];
}

async function getGeminiModels(apiKey: string): Promise<vscode.QuickPickItem[]> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Gemini API error: ${response.status}`);
        }
        const data = (await response.json()) as { models?: GeminiModelItem[] };
        if (!data.models || data.models.length === 0) {
            throw new Error('No models returned from Gemini API.');
        }

        return data.models
            .filter(m => m.supportedGenerationMethods.includes('generateContent'))
            .map(m => {
                const cleanName = m.name.replace(/^models\//, '');
                return {
                    label: cleanName,
                    description: m.displayName,
                    detail: m.description,
                };
            });
    } catch (err) {
        throw new Error(
            `Failed to fetch models from Gemini API.\n` +
            `Details: ${(err as Error).message}`
        );
    }
}

async function callGemini(prompt: string, overrideModel?: string): Promise<string> {
    const config = vscode.workspace.getConfiguration('sortAnything');
    const apiKey = config.get<string>('geminiApiKey', '').trim();
    const model = (overrideModel || 'gemini-3.5-flash').trim();

    if (!apiKey) {
        const action = await vscode.window.showErrorMessage(
            'Sort Anything: Gemini API Key is missing.',
            'Open Settings'
        );
        if (action === 'Open Settings') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'sortAnything');
        }
        throw new Error('Gemini API Key missing — operation cancelled.');
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const body = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 512 },
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Gemini API error (${response.status}): ${errText}`);
    }

    const data = (await response.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
    };

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) { throw new Error('Gemini returned an empty response.'); }
    return text;
}

// ---------------------------------------------------------------------------
// Ollama provider
// ---------------------------------------------------------------------------

async function callOllama(prompt: string, overrideModel?: string): Promise<string> {
    const config = vscode.workspace.getConfiguration('sortAnything');
    const endpoint = config.get<string>('ollamaEndpoint', 'http://localhost:11434').trim().replace(/\/$/, '');
    const model = (overrideModel || config.get<string>('ollamaModel', 'llama3')).trim();

    const url = `${endpoint}/api/generate`;
    const body = { model, prompt, stream: false, options: { temperature: 0.3 } };

    let response: Response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    } catch {
        throw new Error(
            `Failed to connect to Ollama at ${endpoint}.\n` +
            'Please ensure Ollama is running (ollama serve) and the endpoint is correct in Settings.'
        );
    }

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Ollama API error (${response.status}): ${errText}`);
    }

    const data = (await response.json()) as { response?: string };
    const text = data.response?.trim();
    if (!text) { throw new Error('Ollama returned an empty response.'); }
    return text;
}

// ---------------------------------------------------------------------------
// Core: generate with a specific provider
// ---------------------------------------------------------------------------

async function runGeneration(
    provider: 'gemini' | 'ollama',
    selectedModel?: string
): Promise<void> {
    // 1. Get git diff
    let diff: string;
    try {
        diff = getGitDiff();
    } catch (err) {
        vscode.window.showErrorMessage(`Sort Anything: ${(err as Error).message}`);
        return;
    }

    if (!diff) {
        vscode.window.showWarningMessage(
            'Sort Anything: No staged changes found. Please run "git add" first.'
        );
        return;
    }

    // 2. Access Git extension API
    const gitExtension = vscode.extensions.getExtension<{
        getAPI(version: number): {
            repositories: { inputBox: { value: string } }[];
        };
    }>('vscode.git');

    if (!gitExtension) {
        vscode.window.showErrorMessage('Sort Anything: VS Code Git extension not found.');
        return;
    }

    const git = gitExtension.exports.getAPI(1);
    if (git.repositories.length === 0) {
        vscode.window.showErrorMessage('Sort Anything: No active Git repository found.');
        return;
    }

    const inputBox = git.repositories[0].inputBox;
    const label = provider === 'gemini' ? 'Gemini' : 'Ollama';

    try {
        const prompt = buildPrompt(diff);
        
        // Show progress spinner in the bottom right toast notification
        const message = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Sort Anything: Generating commit message with ${label}...`,
                cancellable: false,
            },
            async () => {
                return provider === 'ollama'
                    ? await callOllama(prompt, selectedModel)
                    : await callGemini(prompt, selectedModel);
            }
        );

        // Insert final message
        inputBox.value = message;
        vscode.window.setStatusBarMessage(`$(check) Sort Anything: Commit message populated from ${label}!`, 4000);
    } catch (err) {
        logError(err, `Failed to generate commit message with ${label}`);
        
        const action = await vscode.window.showErrorMessage(
            `Sort Anything: ${(err as Error).message}`,
            'Open Settings'
        );
        if (action === 'Open Settings') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'sortAnything');
        }
    }
}

// ---------------------------------------------------------------------------
// Ollama models list helper
// ---------------------------------------------------------------------------

interface OllamaModelItem {
    name: string;
    details?: {
        parameter_size?: string;
        quantization_level?: string;
    };
}

async function getOllamaModels(endpoint: string): Promise<vscode.QuickPickItem[]> {
    const url = `${endpoint}/api/tags`;
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Ollama API error: ${response.status}`);
        }
        const data = (await response.json()) as { models?: OllamaModelItem[] };
        if (!data.models || data.models.length === 0) {
            throw new Error('No models found in Ollama. Please run "ollama pull <model>" first.');
        }

        return data.models.map(m => ({
            label: m.name,
            description: m.details
                ? `Size: ${m.details.parameter_size || 'N/A'} | Quant: ${m.details.quantization_level || 'N/A'}`
                : '',
        }));
    } catch (err) {
        throw new Error(
            `Could not connect to Ollama at ${endpoint}.\n` +
            `Details: ${(err as Error).message}\n` +
            'Ensure Ollama is running and CORS/Endpoint settings are correct.'
        );
    }
}

// ---------------------------------------------------------------------------
// Main export — QuickPick entry point
// ---------------------------------------------------------------------------

export async function generateCommitMessage(context: vscode.ExtensionContext): Promise<void> {
    const config = vscode.workspace.getConfiguration('sortAnything');
    const currentProvider = config.get<string>('aiProvider', 'gemini');
    
    // Read last used models from globalState
    const geminiModel = context.globalState.get<string>('lastGeminiModel', 'gemini-3.5-flash');
    const ollamaModel = context.globalState.get<string>('lastOllamaModel', 'llama3');
    
    const geminiApiKey = config.get<string>('geminiApiKey', '').trim();
    const ollamaEndpoint = config.get<string>('ollamaEndpoint', 'http://localhost:11434').trim().replace(/\/$/, '');

    type ActionItem = vscode.QuickPickItem & { action: 'gemini' | 'ollama' | 'settings' };

    const items: ActionItem[] = [
        {
            label: '$(sparkle) Generate Commit Message with Gemini',
            description: geminiModel + (currentProvider === 'gemini' ? '  $(check) current' : ''),
            action: 'gemini',
        },
        {
            label: '$(hubot) Generate Commit Message with Ollama',
            description: ollamaModel + (currentProvider === 'ollama' ? '  $(check) current' : ''),
            action: 'ollama',
        },
        {
            label: '$(settings-gear) Switch AI Provider / Configure...',
            description: 'Open Settings to change provider, model, or API keys',
            action: 'settings',
        },
    ];

    const picked = await vscode.window.showQuickPick(items, {
        title: 'Sort Anything — Generate Commit Message',
        placeHolder: 'Select AI provider to generate commit message',
        matchOnDescription: true,
    });

    if (!picked) { return; }

    if (picked.action === 'settings') {
        vscode.commands.executeCommand('workbench.action.openSettings', 'sortAnything');
        return;
    }

    if (picked.action === 'gemini') {
        if (!geminiApiKey) {
            const action = await vscode.window.showErrorMessage(
                'Sort Anything: Gemini API Key is missing.',
                'Open Settings'
            );
            if (action === 'Open Settings') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'sortAnything');
            }
            return;
        }

        // Fetch Gemini models
        let modelItems: vscode.QuickPickItem[];
        try {
            modelItems = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Sort Anything: Fetching model list from Gemini...',
                    cancellable: false,
                },
                () => getGeminiModels(geminiApiKey)
            );
        } catch (err) {
            logError(err, 'Failed to fetch models from Gemini');
            const action = await vscode.window.showErrorMessage(
                `Sort Anything: ${(err as Error).message}`,
                'Open Settings'
            );
            if (action === 'Open Settings') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'sortAnything');
            }
            return;
        }

        const pickedModel = await vscode.window.showQuickPick(modelItems, {
            title: 'Sort Anything — Select Gemini Model',
            placeHolder: 'Select a Gemini model',
            matchOnDescription: true,
        });

        if (!pickedModel) { return; } // Cancelled

        // Save last used model in globalState and update provider in settings
        await context.globalState.update('lastGeminiModel', pickedModel.label);
        await config.update('aiProvider', 'gemini', vscode.ConfigurationTarget.Global);
        
        await runGeneration('gemini', pickedModel.label);

    } else if (picked.action === 'ollama') {
        // Step to choose installed model from local Ollama
        let modelItems: vscode.QuickPickItem[];
        try {
            modelItems = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Sort Anything: Fetching model list from Ollama...',
                    cancellable: false,
                },
                () => getOllamaModels(ollamaEndpoint)
            );
        } catch (err) {
            logError(err, 'Failed to fetch models from Ollama');
            
            const action = await vscode.window.showErrorMessage(
                `Sort Anything: ${(err as Error).message}`,
                'Open Settings'
            );
            if (action === 'Open Settings') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'sortAnything');
            }
            return;
        }

        const pickedModel = await vscode.window.showQuickPick(modelItems, {
            title: 'Sort Anything — Select Ollama Model',
            placeHolder: 'Select an available local model',
            matchOnDescription: true,
        });

        if (!pickedModel) { return; } // Model selection cancelled

        // Save last used model in globalState and update provider in settings
        await context.globalState.update('lastOllamaModel', pickedModel.label);
        await config.update('aiProvider', 'ollama', vscode.ConfigurationTarget.Global);
        
        await runGeneration('ollama', pickedModel.label);
    }
}
