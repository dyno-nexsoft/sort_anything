import * as vscode from 'vscode';
import * as pty from 'node-pty';
import * as os from 'os';

export class OpencodeWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'opencode.sidebar.view';

    private _view?: vscode.WebviewView;
    private _ptyProcess?: pty.IPty;

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

        webviewView.webview.onDidReceiveMessage(data => {
            switch (data.type) {
                case 'terminalInput':
                    this._ptyProcess?.write(data.value);
                    break;
                case 'terminalResize':
                    this._ptyProcess?.resize(data.cols, data.rows);
                    break;
                case 'reloadTerminal':
                    this._reloadPty();
                    break;
                case 'closeTerminal':
                    this._closePty();
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
        const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';
        
        this._ptyProcess = pty.spawn(shell, [], {
            name: 'xterm-color',
            cols: 80,
            rows: 30,
            cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.env.HOME || process.env.USERPROFILE,
            env: process.env as Record<string, string>
        });

        this._ptyProcess.onData((data) => {
            this._view?.webview.postMessage({ type: 'terminalOutput', value: data });
        });

        // Run opencode command
        setTimeout(() => {
            this._ptyProcess?.write('opencode\r');
        }, 1000);
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
                    body, html {
                        margin: 0;
                        padding: 0;
                        height: 100%;
                        overflow: hidden;
                        background-color: var(--vscode-terminal-background);
                        display: flex;
                        flex-direction: column;
                    }
                    .toolbar {
                        display: flex;
                        gap: 8px;
                        padding: 8px;
                        background-color: var(--vscode-sideBar-background);
                        border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
                    }
                    button {
                        display: flex;
                        align-items: center;
                        gap: 4px;
                        background-color: var(--vscode-button-secondaryBackground);
                        color: var(--vscode-button-secondaryForeground);
                        border: none;
                        padding: 4px 8px;
                        cursor: pointer;
                        border-radius: 2px;
                        font-family: var(--vscode-font-family);
                        font-size: 12px;
                    }
                    button:hover {
                        background-color: var(--vscode-button-secondaryHoverBackground);
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
                <div class="toolbar">
                    <button id="btn-reload">
                        <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14"><path d="M13.62 3.62l1.32-1.32.7.7v4H11.64l.7-.7 1.25-1.25A5.66 5.66 0 0 0 8 2.06c-3.1 0-5.63 2.5-5.63 5.63s2.53 5.63 5.63 5.63a5.53 5.53 0 0 0 4.9-2.88l.88.46A6.6 6.6 0 0 1 8 14.31a6.63 6.63 0 0 1-6.63-6.63A6.63 6.63 0 0 1 8 1.06a6.54 6.54 0 0 1 5.62 2.56z"/></svg>
                        Reload
                    </button>
                    <button id="btn-close">
                        <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14"><path d="M14.7 2.7l-.7-.7L8 8 2 2l-.7.7L7.3 8.7 1.3 14.7l.7.7L8 9.4l6 6 .7-.7-6-6 6-6z"/></svg>
                        Close
                    </button>
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

                    window.addEventListener('resize', () => {
                        fitAddon.fit();
                        vscode.postMessage({
                            type: 'terminalResize',
                            cols: term.cols,
                            rows: term.rows
                        });
                    });

                    document.getElementById('btn-reload').addEventListener('click', () => {
                        document.getElementById('terminal-container').style.display = 'block';
                        document.getElementById('closed-state').style.display = 'none';
                        vscode.postMessage({ type: 'reloadTerminal' });
                    });
                    document.getElementById('btn-start').addEventListener('click', () => {
                        document.getElementById('terminal-container').style.display = 'block';
                        document.getElementById('closed-state').style.display = 'none';
                        vscode.postMessage({ type: 'reloadTerminal' });
                    });
                    document.getElementById('btn-close').addEventListener('click', () => {
                        document.getElementById('terminal-container').style.display = 'none';
                        document.getElementById('closed-state').style.display = 'flex';
                        vscode.postMessage({ type: 'closeTerminal' });
                    });

                    term.onData(data => {
                        vscode.postMessage({
                            type: 'terminalInput',
                            value: data
                        });
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
