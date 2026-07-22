import * as vscode from 'vscode';
import * as pty from 'node-pty';
import * as os from 'os';

export class OpencodeWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'opencode.sidebar.view';

    private _view?: vscode.WebviewView;
    private _ptyProcess?: pty.IPty;
    private _currentCli: string = 'opencode';

    constructor(
        private readonly _extensionUri: vscode.Uri,
    ) { }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this._extensionUri
            ]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        this._setupPty();

        webviewView.webview.onDidReceiveMessage(
            message => {
                switch (message.type) {
                    case 'terminalInput':
                        if (this._ptyProcess) {
                            this._ptyProcess.write(message.value);
                        }
                        break;
                    case 'terminalResize':
                        if (this._ptyProcess) {
                            this._ptyProcess.resize(message.cols, message.rows);
                        }
                        break;
                    case 'reloadTerminal':
                        this._reloadPty();
                        break;
                    case 'closeTerminal':
                        this._closePty();
                        break;
                    case 'openClaude':
                        this._switchCli('claude');
                        break;
                    case 'openGemini':
                        this._switchCli('gemini');
                        break;
                    case 'openOpencode':
                        this._switchCli('opencode');
                        break;
                    case 'requestPaste':
                        vscode.env.clipboard.readText().then(text => {
                            if (this._ptyProcess && text) {
                                this._ptyProcess.write(text);
                            }
                        });
                        break;
                }
            });

        webviewView.onDidDispose(() => {
            if (this._ptyProcess) {
                this._ptyProcess.kill();
                this._ptyProcess = undefined;
            }
        });
    }

    private _switchCli(cli: string) {
        if (this._currentCli === cli && this._ptyProcess) {
            return; // Already running this CLI
        }
        this._currentCli = cli;
        this._reloadPty();
    }

    private _reloadPty() {
        if (this._ptyProcess) {
            this._ptyProcess.kill();
        }
        this._view?.webview.postMessage({ type: 'terminalClear' });
        this._setupPty();
    }

    private _closePty() {
        if (this._ptyProcess) {
            this._ptyProcess.kill();
            this._ptyProcess = undefined;
        }
        this._view?.webview.postMessage({ type: 'terminalClear' });
        this._view?.webview.postMessage({ type: 'terminalOutput', value: '\r\n[Opencode process closed. Click Reload to start again.]\r\n' });
    }

    private _setupPty() {
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const config = vscode.workspace.getConfiguration('dynoExtension');
        const command = config.get<string>(`terminal.${this._currentCli}Command`) || this._currentCli;

        this._ptyProcess = pty.spawn(process.platform === 'win32' ? 'powershell.exe' : 'bash', ['-NoExit', '-Command', command], {
            name: 'xterm-color',
            cols: 80,
            rows: 30,
            cwd: cwd,
            env: process.env as Record<string, string>
        });

        this._ptyProcess.onData(data => {
            this._view?.webview.postMessage({ type: 'terminalOutput', value: data });
        });
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const xtermCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'));
        const xtermJsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js'));
        const fitAddonJsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@xterm', 'addon-fit', 'lib', 'addon-fit.js'));

        const nonce = getNonce();

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link href="${xtermCssUri}" rel="stylesheet">
                <title>Opencode Terminal</title>
                <style>
                    body {
                        margin: 0;
                        padding: 0;
                        height: 100vh;
                        display: flex;
                        flex-direction: column;
                        background-color: var(--vscode-editor-background);
                        color: var(--vscode-foreground);
                        overflow: hidden;
                    }
                    .tab-bar {
                        display: flex;
                        background-color: var(--vscode-editor-background);
                        border-bottom: 1px solid var(--vscode-panel-border);
                        align-items: center;
                    }
                    .tab-group {
                        display: flex;
                        flex: 1;
                    }
                    .tab-bar button {
                        padding: 8px 10px;
                        background: transparent;
                        border: none;
                        border-bottom: 2px solid transparent;
                        color: var(--vscode-foreground);
                        cursor: pointer;
                        font-family: var(--vscode-font-family);
                        font-size: 11px;
                        text-transform: uppercase;
                        font-weight: 600;
                        display: flex;
                        align-items: center;
                        gap: 6px;
                        opacity: 0.6;
                        transition: opacity 0.2s, border-bottom-color 0.2s, background-color 0.2s;
                    }
                    .tab-bar button:hover {
                        opacity: 1;
                        background-color: var(--vscode-list-hoverBackground);
                    }
                    .tab-group button.active {
                        opacity: 1;
                        border-bottom-color: var(--vscode-panelTitle-activeBorder);
                        color: var(--vscode-panelTitle-activeForeground);
                    }
                    .tab-bar svg {
                        width: 14px;
                        height: 14px;
                    }
                    #terminal-container {
                        flex: 1;
                        width: 100%;
                        padding: 4px;
                        box-sizing: border-box;
                    }
                    #closed-state {
                        flex: 1;
                        display: none;
                        flex-direction: column;
                        align-items: center;
                        justify-content: center;
                        color: var(--vscode-foreground);
                        font-family: var(--vscode-font-family);
                        font-size: 13px;
                    }
                    #closed-state button {
                        margin-top: 12px;
                        padding: 6px 12px;
                        font-size: 13px;
                    }
                    /* Tweak xterm.js colors to match VS Code */
                    .xterm .xterm-viewport {
                        background-color: transparent !important;
                    }
                    /* Custom Scrollbar for Webview to match VS Code */
                    ::-webkit-scrollbar {
                        width: 10px;
                        height: 10px;
                    }
                    ::-webkit-scrollbar-track {
                        background-color: transparent;
                    }
                    ::-webkit-scrollbar-thumb {
                        background-color: var(--vscode-scrollbarSlider-background);
                    }
                    ::-webkit-scrollbar-thumb:hover {
                        background-color: var(--vscode-scrollbarSlider-hoverBackground);
                    }
                    ::-webkit-scrollbar-thumb:active {
                        background-color: var(--vscode-scrollbarSlider-activeBackground);
                    }
                </style>
            </head>
            <body>
                <div class="tab-bar">
                    <div class="tab-group">
                        <button id="tab-opencode" class="active" title="Opencode">
                            <svg viewBox="0 0 16 16" fill="currentColor"><path d="M14.5 2h-13c-.8 0-1.5.7-1.5 1.5v9c0 .8.7 1.5 1.5 1.5h13c.8 0 1.5-.7 1.5-1.5v-9c0-.8-.7-1.5-1.5-1.5zm0 10.5h-13v-9h13v9z"/><path d="M3.5 5.5l3 2.5-3 2.5.8.8 4-3.3-4-3.3zM8.5 10h4v1h-4z"/></svg>
                            Opencode
                        </button>
                        <button id="tab-claude" title="Claude Code">
                            <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 13V2a6 6 0 1 1 0 12zM5.5 8a2.5 2.5 0 1 1 5 0 2.5 2.5 0 0 1-5 0z"/></svg>
                            Claude
                        </button>
                        <button id="tab-gemini" title="Gemini CLI">
                            <svg viewBox="0 0 16 16" fill="currentColor"><path d="M13.4 2.6l-1-1-2.2 2.2-1.2-1.2 2.2-2.2-1-1h4.2v4.2l-1-1-1.2 1.2-2.2-2.2zm-10.8 0l1 1 2.2-2.2 1.2 1.2-2.2 2.2 1 1H2.4V2.6l1 1 1.2-1.2 2.2 2.2zM2.6 13.4l1 1 2.2-2.2 1.2 1.2-2.2 2.2 1 1H2.4v-4.2l1-1-1.2 1.2 2.2 2.2zm10.8 0l-1-1-2.2 2.2-1.2-1.2 2.2-2.2-1-1h4.2v4.2l-1 1 1.2-1.2-2.2-2.2zM8 4.5A3.5 3.5 0 1 0 11.5 8 3.5 3.5 0 0 0 8 4.5zm0 6A2.5 2.5 0 1 1 10.5 8 2.5 2.5 0 0 1 8 10.5z"/></svg>
                            Gemini
                        </button>
                    </div>
                </div>
                <div id="terminal-container"></div>
                <div id="closed-state">
                    <div>Opencode terminal is closed.</div>
                    <button id="btn-start">Start Opencode</button>
                </div>

                <script nonce="${nonce}" src="${xtermJsUri}"></script>
                <script nonce="${nonce}" src="${fitAddonJsUri}"></script>
                <script nonce="${nonce}">
                    const vscode = acquireVsCodeApi();
                    
                    const term = new Terminal({
                        theme: {
                            background: getComputedStyle(document.body).getPropertyValue('--vscode-terminal-background') || '#1e1e1e',
                            foreground: getComputedStyle(document.body).getPropertyValue('--vscode-terminal-foreground') || '#cccccc',
                        },
                        cursorBlink: true,
                        fontFamily: getComputedStyle(document.body).getPropertyValue('--vscode-editor-font-family') || 'Consolas, monospace',
                        fontSize: parseInt(getComputedStyle(document.body).getPropertyValue('--vscode-editor-font-size')) || 14
                    });

                    const fitAddon = new FitAddon.FitAddon();
                    term.loadAddon(fitAddon);
                    
                    term.open(document.getElementById('terminal-container'));
                    fitAddon.fit();

                    // Send resize to pty
                    vscode.postMessage({
                        type: 'terminalResize',
                        cols: term.cols,
                        rows: term.rows
                    });

                    const resizeObserver = new ResizeObserver(() => {
                        try {
                            fitAddon.fit();
                            vscode.postMessage({
                                type: 'terminalResize',
                                cols: term.cols,
                                rows: term.rows
                            });
                        } catch (e) {
                            // Container might be hidden
                        }
                    });
                    resizeObserver.observe(document.getElementById('terminal-container'));
                    
                    const tabs = ['tab-opencode', 'tab-claude', 'tab-gemini'];
                    const activateTab = (tabId) => {
                        tabs.forEach(id => document.getElementById(id).classList.remove('active'));
                        document.getElementById(tabId).classList.add('active');
                        document.getElementById('terminal-container').style.display = 'block';
                        document.getElementById('closed-state').style.display = 'none';
                    };

                    document.getElementById('tab-opencode').addEventListener('click', () => {
                        activateTab('tab-opencode');
                        vscode.postMessage({ type: 'openOpencode' });
                    });
                    document.getElementById('tab-claude').addEventListener('click', () => {
                        activateTab('tab-claude');
                        vscode.postMessage({ type: 'openClaude' });
                    });
                    document.getElementById('tab-gemini').addEventListener('click', () => {
                        activateTab('tab-gemini');
                        vscode.postMessage({ type: 'openGemini' });
                    });

                    term.onData(data => {
                        vscode.postMessage({
                            type: 'terminalInput',
                            value: data
                        });
                    });

                    // Handle Right-Click to Paste
                    document.getElementById('terminal-container').addEventListener('contextmenu', e => {
                        e.preventDefault();
                        vscode.postMessage({ type: 'requestPaste' });
                    });

                    // Handle Ctrl+V / Cmd+V to Paste
                    term.attachCustomKeyEventHandler(e => {
                        if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
                            vscode.postMessage({ type: 'requestPaste' });
                            return false; // Stop propagation and default behavior
                        }
                        return true;
                    });

                    window.addEventListener('message', event => {
                        const message = event.data;
                        switch (message.type) {
                            case 'terminalOutput':
                                term.write(message.value);
                                break;
                            case 'terminalClear':
                                term.reset();
                                fitAddon.fit();
                                vscode.postMessage({
                                    type: 'terminalResize',
                                    cols: term.cols,
                                    rows: term.rows
                                });
                                break;
                        }
                    });
                </script>
            </body>
            </html>`;
    }
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
