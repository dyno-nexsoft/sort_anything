import * as vscode from 'vscode';
import { execSync } from 'child_process';

// ---------------------------------------------------------------------------
// Git diff
// ---------------------------------------------------------------------------

function getWorkspaceRoot(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        throw new Error('Không tìm thấy workspace. Hãy mở một folder/project trước.');
    }
    return folders[0].uri.fsPath;
}

function getGitDiff(): string {
    const cwd = getWorkspaceRoot();
    try {
        const diff = execSync('git diff --staged', { cwd, encoding: 'utf-8' });
        return diff.trim();
    } catch (err) {
        throw new Error('Không thể chạy git. Hãy đảm bảo git đã được cài đặt và folder này là git repository.');
    }
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildPrompt(diff: string): string {
    return `You are a senior software engineer. Based on the following git diff, write a concise and descriptive commit message following Conventional Commits format (e.g., feat:, fix:, refactor:, chore:, docs:, style:, test:, build:, ci:, perf:).

Rules:
- Output ONLY the commit message text, nothing else.
- No backticks, no markdown, no explanation.
- Keep the subject line under 72 characters.
- Use imperative mood (e.g., "add", "fix", "update" — not "added", "fixed").
- If there are multiple changes, use a short subject + bullet body separated by a blank line.

Git diff:
\`\`\`
${diff}
\`\`\``;
}

// ---------------------------------------------------------------------------
// Gemini provider
// ---------------------------------------------------------------------------

async function callGemini(prompt: string): Promise<string> {
    const config = vscode.workspace.getConfiguration('sortAnything');
    const apiKey = config.get<string>('geminiApiKey', '').trim();
    const model = config.get<string>('geminiModel', 'gemini-2.0-flash').trim();

    if (!apiKey) {
        const action = await vscode.window.showErrorMessage(
            'Sort Anything: Chưa có Gemini API Key.',
            'Mở Settings'
        );
        if (action === 'Mở Settings') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'sortAnything.geminiApiKey');
        }
        throw new Error('Thiếu Gemini API Key — đã hủy.');
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
        throw new Error(`Gemini API lỗi (${response.status}): ${errText}`);
    }

    const data = (await response.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
    };

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) { throw new Error('Gemini trả về kết quả rỗng.'); }
    return text;
}

// ---------------------------------------------------------------------------
// Ollama provider
// ---------------------------------------------------------------------------

async function callOllama(prompt: string): Promise<string> {
    const config = vscode.workspace.getConfiguration('sortAnything');
    const endpoint = config.get<string>('ollamaEndpoint', 'http://localhost:11434').trim().replace(/\/$/, '');
    const model = config.get<string>('ollamaModel', 'llama3').trim();

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
            `Không thể kết nối Ollama tại ${endpoint}.\n` +
            'Hãy đảm bảo Ollama đang chạy (ollama serve) và endpoint đúng trong Settings.'
        );
    }

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Ollama API lỗi (${response.status}): ${errText}`);
    }

    const data = (await response.json()) as { response?: string };
    const text = data.response?.trim();
    if (!text) { throw new Error('Ollama trả về kết quả rỗng.'); }
    return text;
}

// ---------------------------------------------------------------------------
// Core: generate with a specific provider
// ---------------------------------------------------------------------------

async function runGeneration(provider: 'gemini' | 'ollama'): Promise<void> {
    // 1. Lấy git diff
    let diff: string;
    try {
        diff = getGitDiff();
    } catch (err) {
        vscode.window.showErrorMessage(`Sort Anything: ${(err as Error).message}`);
        return;
    }

    if (!diff) {
        vscode.window.showWarningMessage(
            'Sort Anything: Không có staged changes. Hãy dùng "git add" trước.'
        );
        return;
    }

    // 2. Lấy Git extension API
    const gitExtension = vscode.extensions.getExtension<{
        getAPI(version: number): {
            repositories: { inputBox: { value: string } }[];
        };
    }>('vscode.git');

    if (!gitExtension) {
        vscode.window.showErrorMessage('Sort Anything: Không tìm thấy Git extension của VS Code.');
        return;
    }

    const git = gitExtension.exports.getAPI(1);
    if (git.repositories.length === 0) {
        vscode.window.showErrorMessage('Sort Anything: Không tìm thấy Git repository đang hoạt động.');
        return;
    }

    const inputBox = git.repositories[0].inputBox;
    const originalValue = inputBox.value;
    const label = provider === 'gemini' ? 'Gemini' : 'Ollama';

    // 3. Set text chờ trực tiếp trong Git Input Box (giống Copilot)
    inputBox.value = `[Generating commit message with ${label}... \u23F3]`;

    try {
        const prompt = buildPrompt(diff);
        const message = provider === 'ollama'
            ? await callOllama(prompt)
            : await callGemini(prompt);

        // Điền thẳng commit message vào ô nhập liệu
        inputBox.value = message;
        vscode.window.setStatusBarMessage(`$(check) Sort Anything: Đã điền commit message từ ${label}!`, 4000);
    } catch (err) {
        // Trả lại text ban đầu của user nếu lỗi xảy ra
        inputBox.value = originalValue;
        vscode.window.showErrorMessage(`Sort Anything: ${(err as Error).message}`);
    }
}

// ---------------------------------------------------------------------------
// Main export — hiện QuickPick với 3 option
// ---------------------------------------------------------------------------

export async function generateCommitMessage(): Promise<void> {
    const config = vscode.workspace.getConfiguration('sortAnything');
    const currentProvider = config.get<string>('aiProvider', 'gemini');
    const geminiModel = config.get<string>('geminiModel', 'gemini-2.0-flash');
    const ollamaModel = config.get<string>('ollamaModel', 'llama3');

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
            description: 'Mở Settings để thay đổi provider, model, API key',
            action: 'settings',
        },
    ];

    const picked = await vscode.window.showQuickPick(items, {
        title: 'Sort Anything — Generate Commit Message',
        placeHolder: 'Chọn AI provider để gen commit message',
        matchOnDescription: true,
    });

    if (!picked) { return; }

    if (picked.action === 'settings') {
        vscode.commands.executeCommand('workbench.action.openSettings', 'sortAnything');
        return;
    }

    // Lưu provider vừa chọn làm default
    await config.update('aiProvider', picked.action, vscode.ConfigurationTarget.Global);

    await runGeneration(picked.action);
}
