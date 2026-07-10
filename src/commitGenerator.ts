import * as vscode from 'vscode';
import { execSync } from 'child_process';
import { logError, logInfo } from './utils';

// ---------------------------------------------------------------------------
// Git diff helper
// ---------------------------------------------------------------------------

function getGitDiff(cwd: string): string {
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

const SYSTEM_INSTRUCTION = `You are a senior software engineer. Based on the following git diff, write a concise and professional commit message following Conventional Commits format (e.g., feat:, fix:, refactor:, chore:, docs:, style:, test:, build:, ci:, perf:).

Rules:
- Output ONLY the raw commit message text, nothing else. Do not wrap in quotes, backticks, or code blocks.
- Use imperative mood (e.g., "add", "fix", "update" — not "added", "fixed", "updates").
- Keep the subject line (first line) under 72 characters.
- Write a SINGLE-LINE message for simple, small, or single-topic changes (e.g., "docs: update README").
- Use a MULTI-LINE message (short subject line + blank line + bulleted body) ONLY for large, complex changes with multiple distinct tasks.
- Keep it natural, clean, and developer-friendly. Avoid repeating obvious file names in bullet points if it's already clear.`;

function buildPrompt(diff: string): string {
    return `Git diff:
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

async function callGemini(prompt: string, systemInstruction: string, overrideModel?: string): Promise<string> {
    const config = vscode.workspace.getConfiguration('dynoExtension');
    const apiKey = config.get<string>('geminiApiKey', '').trim();
    const model = (overrideModel || 'gemini-3.5-flash').trim();

    if (!apiKey) {
        const action = await vscode.window.showErrorMessage(
            'Dyno Extension: Gemini API Key is missing.',
            'Open Settings'
        );
        if (action === 'Open Settings') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'dynoExtension');
        }
        throw new Error('Gemini API Key missing — operation cancelled.');
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const body = {
        contents: [{ parts: [{ text: prompt }] }],
        systemInstruction: {
            parts: [{ text: systemInstruction }]
        },
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

async function callOllama(prompt: string, systemPrompt: string, overrideModel?: string): Promise<string> {
    const config = vscode.workspace.getConfiguration('dynoExtension');
    const endpoint = config.get<string>('ollamaEndpoint', 'http://localhost:11434').trim().replace(/\/$/, '');
    const model = (overrideModel || config.get<string>('ollamaModel', 'llama3')).trim();

    const url = `${endpoint}/api/generate`;
    const body = { model, prompt, system: systemPrompt, stream: false, options: { temperature: 0.3 } };

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

function cleanCommitMessage(msg: string): string {
    let cleaned = msg.trim();
    
    // Extract content from a code block if present
    const codeBlockRegex = /```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n```/;
    const match = cleaned.match(codeBlockRegex);
    if (match && match[1]) {
        return match[1].trim();
    }
    
    // Fallback: inline code block
    const inlineCodeBlockRegex = /```([\s\S]*?)```/;
    const inlineMatch = cleaned.match(inlineCodeBlockRegex);
    if (inlineMatch && inlineMatch[1]) {
        return inlineMatch[1].trim();
    }

    // Strip leading/trailing backticks just in case
    cleaned = cleaned.replace(/^```[a-zA-Z]*\s+/, '');
    cleaned = cleaned.replace(/\s+```$/, '');
    
    return cleaned.trim();
}

// ---------------------------------------------------------------------------
// Core: generate with a specific provider
// ---------------------------------------------------------------------------

async function runGeneration(
    provider: 'gemini' | 'ollama',
    selectedModel?: string,
    scm?: any
): Promise<void> {
    // 1. Access Git extension API
    const gitExtension = vscode.extensions.getExtension<{
        getAPI(version: number): {
            repositories: {
                rootUri: vscode.Uri;
                inputBox: { value: string };
            }[];
        };
    }>('vscode.git');

    if (!gitExtension) {
        vscode.window.showErrorMessage('Dyno Extension: VS Code Git extension not found.');
        return;
    }

    const git = gitExtension.exports.getAPI(1);
    if (git.repositories.length === 0) {
        vscode.window.showErrorMessage('Dyno Extension: No active Git repository found.');
        return;
    }

    let selectedRepo = git.repositories[0];
    let matchedRepo = false;

    // Check if we can determine the repository from the scm context (e.g. when button clicked in SCM view)
    if (scm && scm.rootUri) {
        const scmPath = scm.rootUri.fsPath.toLowerCase();
        const found = git.repositories.find(
            repo => repo.rootUri.fsPath.toLowerCase() === scmPath
        );
        if (found) {
            selectedRepo = found;
            matchedRepo = true;
        }
    }

    // 2. If multiple repos and we couldn't match from context, prompt user to select one
    if (!matchedRepo && git.repositories.length > 1) {
        const repoItems = git.repositories.map(repo => {
            const folderName = repo.rootUri.fsPath.split(/[\\/]/).pop() || repo.rootUri.fsPath;
            return {
                label: `$(repo) ${folderName}`,
                description: repo.rootUri.fsPath,
                repo: repo
            };
        });

        const pickedRepo = await vscode.window.showQuickPick(repoItems, {
            title: 'Dyno Extension — Select Git Repository',
            placeHolder: 'Select the repository to generate a commit message for',
            matchOnDescription: true,
        });

        if (!pickedRepo) {
            return; // user cancelled
        }
        selectedRepo = pickedRepo.repo;
    }

    // 3. Get git diff for selected repo
    let diff: string;
    try {
        diff = getGitDiff(selectedRepo.rootUri.fsPath);
    } catch (err) {
        vscode.window.showErrorMessage(`Dyno Extension: ${(err as Error).message}`);
        return;
    }

    if (!diff) {
        vscode.window.showWarningMessage(
            'Dyno Extension: No staged changes found. Please run "git add" first.'
        );
        return;
    }

    const inputBox = selectedRepo.inputBox;
    const label = provider === 'gemini' ? 'Gemini' : 'Ollama';

    try {
        const prompt = buildPrompt(diff);
        
        // Show progress spinner in the bottom right toast notification
        const message = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Dyno Extension: Generating commit message with ${label}...`,
                cancellable: false,
            },
            async () => {
                const raw = provider === 'ollama'
                    ? await callOllama(prompt, SYSTEM_INSTRUCTION, selectedModel)
                    : await callGemini(prompt, SYSTEM_INSTRUCTION, selectedModel);
                return cleanCommitMessage(raw);
            }
        );

        // Insert final message
        inputBox.value = message;
        vscode.window.setStatusBarMessage(`$(check) Dyno Extension: Commit message populated from ${label}!`, 4000);
    } catch (err) {
        logError(err, `Failed to generate commit message with ${label}`);
        
        const action = await vscode.window.showErrorMessage(
            `Dyno Extension: ${(err as Error).message}`,
            'Open Settings'
        );
        if (action === 'Open Settings') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'dynoExtension');
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

let sessionGeminiModel: string | undefined;
let sessionOllamaModel: string | undefined;

export async function generateCommitMessage(context: vscode.ExtensionContext, scm?: any): Promise<void> {
    const config = vscode.workspace.getConfiguration('dynoExtension');
    const currentProvider = context.globalState.get<string>('lastAiProvider', 'gemini');
    
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
            label: '$(settings-gear) Configure API Keys & Endpoints...',
            description: 'Open Settings to configure Gemini API Key or Ollama Endpoint',
            action: 'settings',
        },
    ];

    const picked = await vscode.window.showQuickPick(items, {
        title: 'Dyno Extension — Generate Commit Message',
        placeHolder: 'Select AI provider to generate commit message',
        matchOnDescription: true,
    });

    if (!picked) { return; }

    if (picked.action === 'settings') {
        vscode.commands.executeCommand('workbench.action.openSettings', 'dynoExtension');
        return;
    }

    if (picked.action === 'gemini') {
        if (!geminiApiKey) {
            const action = await vscode.window.showErrorMessage(
                'Dyno Extension: Gemini API Key is missing.',
                'Open Settings'
            );
            if (action === 'Open Settings') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'dynoExtension');
            }
            return;
        }

        let targetModel = sessionGeminiModel;

        if (!targetModel) {
            // Fetch Gemini models
            let modelItems: vscode.QuickPickItem[];
            try {
                modelItems = await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: 'Dyno Extension: Fetching model list from Gemini...',
                        cancellable: false,
                    },
                    () => getGeminiModels(geminiApiKey)
                );
            } catch (err) {
                logError(err, 'Failed to fetch models from Gemini');
                const action = await vscode.window.showErrorMessage(
                    `Dyno Extension: ${(err as Error).message}`,
                    'Open Settings'
                );
                if (action === 'Open Settings') {
                    vscode.commands.executeCommand('workbench.action.openSettings', 'dynoExtension');
                }
                return;
            }

            const pickedModel = await vscode.window.showQuickPick(modelItems, {
                title: 'Dyno Extension — Select Gemini Model',
                placeHolder: 'Select a Gemini model',
                matchOnDescription: true,
            });

            if (!pickedModel) { return; } // Cancelled

            targetModel = pickedModel.label;
            sessionGeminiModel = targetModel;
            // Save last used model in globalState and update provider in settings
            await context.globalState.update('lastGeminiModel', targetModel);
        }

        await context.globalState.update('lastAiProvider', 'gemini');
        await runGeneration('gemini', targetModel, scm);

    } else if (picked.action === 'ollama') {
        let targetModel = sessionOllamaModel;

        if (!targetModel) {
            // Step to choose installed model from local Ollama
            let modelItems: vscode.QuickPickItem[];
            try {
                modelItems = await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: 'Dyno Extension: Fetching model list from Ollama...',
                        cancellable: false,
                    },
                    () => getOllamaModels(ollamaEndpoint)
                );
            } catch (err) {
                logError(err, 'Failed to fetch models from Ollama');
                
                const action = await vscode.window.showErrorMessage(
                    `Dyno Extension: ${(err as Error).message}`,
                    'Open Settings'
                );
                if (action === 'Open Settings') {
                    vscode.commands.executeCommand('workbench.action.openSettings', 'dynoExtension');
                }
                return;
            }

            const pickedModel = await vscode.window.showQuickPick(modelItems, {
                title: 'Dyno Extension — Select Ollama Model',
                placeHolder: 'Select an available local model',
                matchOnDescription: true,
            });

            if (!pickedModel) { return; } // Model selection cancelled

            targetModel = pickedModel.label;
            sessionOllamaModel = targetModel;
            // Save last used model in globalState and update provider in settings
            await context.globalState.update('lastOllamaModel', targetModel);
        }

        await context.globalState.update('lastAiProvider', 'ollama');
        await runGeneration('ollama', targetModel, scm);
    }
}
