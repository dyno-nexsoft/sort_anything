import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { logInfo } from './utils';
import { MonitorHookServer } from './monitorHook';

/**
 * Claude Task Monitor
 * -------------------
 * A webview (center editor area) that visualizes what Claude Code is doing in
 * the current workspace, by tailing Claude Code's transcript JSONL files under
 * ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl.
 *
 * Data sources:
 *   - transcript JSONL (authoritative, full history) — parsed incrementally
 *   - optional PostToolUse/UserPromptSubmit/Stop hook (near-instant "poke")
 *   - `git status --porcelain` for change badges
 */

// ---------------------------------------------------------------------------
// Transcript location
// ---------------------------------------------------------------------------

/** Claude encodes the cwd into a folder name by replacing every non-alphanumeric
 *  char with '-'. e.g. e:\Projects\sort_anything -> e--Projects-sort-anything */
function encodeProjectDir(cwd: string): string {
    return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}
function projectsDirForWorkspace(cwd: string): string {
    return path.join(os.homedir(), '.claude', 'projects', encodeProjectDir(cwd));
}

interface SessionInfo {
    file: string;
    id: string;
    title: string;
    mtime: number;
}

function listSessions(dir: string): SessionInfo[] {
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return []; }
    const out: SessionInfo[] = [];
    for (const name of entries) {
        if (!name.endsWith('.jsonl')) { continue; }
        const full = path.join(dir, name);
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch { continue; }
        out.push({ file: full, id: name.replace(/\.jsonl$/, ''), title: '', mtime });
    }
    out.sort((a, b) => b.mtime - a.mtime);
    // cheaply grab the ai-title from the tail of each file (best-effort)
    for (const s of out) {
        s.title = readTitle(s.file) || '';
    }
    return out;
}

function readTitle(file: string): string | undefined {
    try {
        const raw = fs.readFileSync(file, 'utf8');
        const lines = raw.split(/\r?\n/);
        for (let i = lines.length - 1; i >= 0; i--) {
            const s = lines[i].trim();
            if (!s) { continue; }
            if (s.includes('"ai-title"')) {
                try { const o = JSON.parse(s); if (o.type === 'ai-title' && o.aiTitle) { return o.aiTitle; } } catch { /* */ }
            }
        }
    } catch { /* */ }
    return undefined;
}

// ---------------------------------------------------------------------------
// Model pricing (USD per 1M tokens) — estimates, best-effort
// ---------------------------------------------------------------------------

interface Pricing { input: number; output: number; cacheWrite: number; cacheRead: number; }
function pricingFor(model: string): Pricing {
    const m = (model || '').toLowerCase();
    if (m.includes('haiku')) { return { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 }; }
    if (m.includes('sonnet')) { return { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 }; }
    // default to Opus-class pricing
    return { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 };
}

// ---------------------------------------------------------------------------
// Types shared with the webview
// ---------------------------------------------------------------------------

interface FileStat {
    path: string;        // absolute path as reported by Claude
    rel: string;         // path relative to cwd (forward slashes)
    reads: number;
    writes: number;      // Edit + Write + MultiEdit
    other: number;       // Grep/Glob targeting the file
    total: number;
    linesAdded: number;
    linesRemoved: number;
}

interface ActivityItem {
    id: string;
    ts: number;
    tool: string;
    detail: string;
    durationMs: number;  // -1 = unknown / still running
    linesChanged: number;
}

interface MonitorState {
    title: string;
    sessionId: string;
    gitBranch: string;
    cwd: string;
    model: string;
    files: FileStat[];
    tools: { name: string; count: number }[];
    activity: ActivityItem[];
    promptMarks: number[];               // timestamps of user prompts
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
    costUsd: number;
    status: { kind: 'running' | 'thinking' | 'idle' | 'waiting'; label: string; tool?: string };
    git: { [rel: string]: string };      // rel path -> status code (M/A/D/?/R/U)
    sessions: { id: string; title: string; file: string; active: boolean }[];
    updatedAt: number;
    hook: boolean;                       // whether the live hook is connected
    error?: string;
}

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read']);
const FILE_TOOLS = new Set([...WRITE_TOOLS, ...READ_TOOLS, 'Grep', 'Glob']);

function toTime(v: unknown): number {
    if (typeof v === 'string') { const t = Date.parse(v); return isNaN(t) ? 0 : t; }
    return 0;
}
function shortName(name: string): string {
    return name.length > 80 ? '…' + name.slice(-77) : name;
}

// ---------------------------------------------------------------------------
// Incremental, stateful transcript aggregator
// ---------------------------------------------------------------------------

class TranscriptAggregator {
    readonly file: string;
    private cwd: string;
    private byteOffset = 0;
    private remainder = '';
    private lastMtime = 0;

    title = '';
    sessionId = '';
    gitBranch = '';
    model = '';

    private files = new Map<string, FileStat>();
    private tools = new Map<string, number>();
    private activity: ActivityItem[] = [];
    private activityById = new Map<string, ActivityItem>();
    private toolStart = new Map<string, { ts: number; file?: string }>();
    private promptMarks: number[] = [];
    tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

    // rolling record of the very last meaningful event, for status detection
    private lastToolUsePending: { id: string; tool: string; ts: number } | undefined;

    constructor(file: string, cwd: string) {
        this.file = file;
        this.cwd = cwd;
    }

    private reset() {
        this.byteOffset = 0; this.remainder = '';
        this.files.clear(); this.tools.clear();
        this.activity = []; this.activityById.clear(); this.toolStart.clear();
        this.promptMarks = [];
        this.tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        this.lastToolUsePending = undefined;
        this.title = ''; this.sessionId = ''; this.gitBranch = ''; this.model = '';
    }

    /** Read only bytes appended since the last call. Returns true if changed. */
    update(): boolean {
        let fd: number;
        try { fd = fs.openSync(this.file, 'r'); } catch { return false; }
        try {
            const st = fs.fstatSync(fd);
            if (st.mtimeMs === this.lastMtime && st.size === this.byteOffset) { return false; }
            this.lastMtime = st.mtimeMs;
            if (st.size < this.byteOffset) { this.reset(); }        // file rotated/truncated
            const len = st.size - this.byteOffset;
            if (len <= 0) { return true; }
            const buf = Buffer.alloc(len);
            fs.readSync(fd, buf, 0, len, this.byteOffset);
            this.byteOffset = st.size;
            this.ingest(buf.toString('utf8'));
            return true;
        } catch { return false; }
        finally { try { fs.closeSync(fd); } catch { /* */ } }
    }

    private touch(absPath: unknown, kind: 'read' | 'write' | 'other'): FileStat | undefined {
        if (typeof absPath !== 'string' || !absPath) { return undefined; }
        let f = this.files.get(absPath);
        if (!f) {
            let rel = absPath;
            try {
                const r = path.relative(this.cwd, absPath);
                if (r && !r.startsWith('..') && !path.isAbsolute(r)) { rel = r; }
            } catch { /* */ }
            f = { path: absPath, rel: rel.replace(/\\/g, '/'), reads: 0, writes: 0, other: 0, total: 0, linesAdded: 0, linesRemoved: 0 };
            this.files.set(absPath, f);
        }
        if (kind === 'read') { f.reads++; } else if (kind === 'write') { f.writes++; } else { f.other++; }
        f.total++;
        return f;
    }

    private ingest(chunk: string) {
        const data = this.remainder + chunk;
        const parts = data.split('\n');
        this.remainder = parts.pop() ?? '';
        for (const line of parts) {
            const s = line.trim();
            if (!s) { continue; }
            let o: any;
            try { o = JSON.parse(s); } catch { continue; }
            this.handle(o);
        }
    }

    private handle(o: any) {
        if (o.sessionId) { this.sessionId = o.sessionId; }
        if (o.gitBranch) { this.gitBranch = o.gitBranch; }
        if (o.cwd) { this.cwd = o.cwd; }
        if (o.type === 'ai-title' && o.aiTitle) { this.title = o.aiTitle; }

        if (o.type === 'assistant' && o.message) {
            const m = o.message;
            if (m.model) { this.model = m.model; }
            if (m.usage) {
                this.tokens.input += m.usage.input_tokens || 0;
                this.tokens.output += m.usage.output_tokens || 0;
                this.tokens.cacheRead += m.usage.cache_read_input_tokens || 0;
                this.tokens.cacheWrite += m.usage.cache_creation_input_tokens || 0;
            }
            if (Array.isArray(m.content)) {
                for (const c of m.content) {
                    if (c.type !== 'tool_use') { continue; }
                    this.onToolUse(c, toTime(o.timestamp));
                }
            }
            return;
        }

        if (o.type === 'user' && o.message) {
            const ts = toTime(o.timestamp);
            const content = o.message.content;
            let isToolResult = false;
            if (Array.isArray(content)) {
                for (const c of content) {
                    if (c.type === 'tool_result') {
                        isToolResult = true;
                        this.onToolResult(c.tool_use_id, ts, o.toolUseResult);
                    }
                }
            }
            // a genuine user prompt (typed text, not a tool result)
            if (!isToolResult && ts && o.promptSource !== 'hook') {
                const hasText = typeof content === 'string'
                    ? content.trim().length > 0
                    : Array.isArray(content) && content.some((c: any) => c.type === 'text' || c.type === 'image');
                if (hasText) { this.promptMarks.push(ts); }
            }
        }
    }

    private onToolUse(c: any, ts: number) {
        const name: string = c.name || 'unknown';
        this.tools.set(name, (this.tools.get(name) || 0) + 1);
        const input = c.input || {};

        let filePath: string | undefined;
        let detail = '';
        if (FILE_TOOLS.has(name) && input.file_path) {
            const kind = WRITE_TOOLS.has(name) ? 'write' : READ_TOOLS.has(name) ? 'read' : 'other';
            this.touch(input.file_path, kind);
            filePath = String(input.file_path);
            detail = filePath;
        } else if (name === 'Bash') {
            detail = String(input.description || input.command || '');
        } else if (name === 'Grep' || name === 'Glob') {
            detail = String(input.pattern || '');
            if (input.path) { this.touch(input.path, 'other'); filePath = String(input.path); }
        } else if (input.file_path) {
            filePath = String(input.file_path);
            detail = filePath;
        } else {
            detail = Object.keys(input).slice(0, 3).map(k => `${k}=${JSON.stringify(input[k])}`).join(' ').slice(0, 120);
        }

        const item: ActivityItem = { id: c.id || '', ts, tool: name, detail: shortName(detail), durationMs: -1, linesChanged: 0 };
        this.activity.push(item);
        if (c.id) {
            this.activityById.set(c.id, item);
            this.toolStart.set(c.id, { ts, file: filePath });
            this.lastToolUsePending = { id: c.id, tool: name, ts };
        }
    }

    private onToolResult(toolUseId: string, ts: number, toolUseResult: any) {
        if (toolUseId && this.lastToolUsePending?.id === toolUseId) { this.lastToolUsePending = undefined; }
        const start = toolUseId ? this.toolStart.get(toolUseId) : undefined;
        const item = toolUseId ? this.activityById.get(toolUseId) : undefined;
        if (item && start && ts >= start.ts) { item.durationMs = ts - start.ts; }

        // lines changed from a write result
        if (toolUseResult && typeof toolUseResult === 'object') {
            const { added, removed } = countPatch(toolUseResult);
            if ((added || removed) && (start?.file || toolUseResult.filePath)) {
                const fp = String(start?.file || toolUseResult.filePath);
                const f = this.files.get(fp);
                if (f) { f.linesAdded += added; f.linesRemoved += removed; }
                if (item) { item.linesChanged = added + removed; }
            }
        }
    }

    getState(active: boolean, mtime: number): Partial<MonitorState> {
        const files = [...this.files.values()].sort((a, b) => b.total - a.total);
        const tools = [...this.tools.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
        const activity = this.activity.slice().sort((a, b) => b.ts - a.ts).slice(0, 400);
        const p = pricingFor(this.model);
        const cost = this.tokens.input / 1e6 * p.input + this.tokens.output / 1e6 * p.output
            + this.tokens.cacheRead / 1e6 * p.cacheRead + this.tokens.cacheWrite / 1e6 * p.cacheWrite;

        // status detection
        const ageMs = Date.now() - mtime;
        let status: MonitorState['status'];
        if (this.lastToolUsePending) {
            const pendingAge = Date.now() - this.lastToolUsePending.ts;
            if (pendingAge > 45000) { status = { kind: 'waiting', label: `Waiting (${this.lastToolUsePending.tool})`, tool: this.lastToolUsePending.tool }; }
            else { status = { kind: 'running', label: `Running ${this.lastToolUsePending.tool}`, tool: this.lastToolUsePending.tool }; }
        } else if (ageMs < 8000) {
            status = { kind: 'thinking', label: 'Thinking…' };
        } else {
            status = { kind: 'idle', label: 'Idle' };
        }

        return {
            title: this.title, sessionId: this.sessionId, gitBranch: this.gitBranch, model: this.model,
            files, tools, activity, promptMarks: this.promptMarks.slice(),
            tokens: { ...this.tokens }, costUsd: cost, status,
        };
    }
}

function countPatch(tur: any): { added: number; removed: number } {
    let added = 0, removed = 0;
    if (tur.type === 'create' && typeof tur.content === 'string') {
        added = tur.content.split('\n').length;
        return { added, removed };
    }
    const sp = tur.structuredPatch;
    if (Array.isArray(sp)) {
        for (const h of sp) {
            if (Array.isArray(h.lines)) {
                for (const ln of h.lines) {
                    if (typeof ln === 'string') {
                        if (ln.startsWith('+')) { added++; } else if (ln.startsWith('-')) { removed++; }
                    }
                }
            } else {
                added += h.newLines || 0; removed += h.oldLines || 0;
            }
        }
    }
    return { added, removed };
}

// ---------------------------------------------------------------------------
// git status
// ---------------------------------------------------------------------------

function gitStatus(cwd: string): Promise<{ [rel: string]: string }> {
    return new Promise((resolve) => {
        execFile('git', ['status', '--porcelain=v1'], { cwd, windowsHide: true }, (err, stdout) => {
            const map: { [rel: string]: string } = {};
            if (err || !stdout) { resolve(map); return; }
            for (const line of stdout.split('\n')) {
                if (line.length < 4) { continue; }
                const code = line.slice(0, 2).trim() || '?';
                let p = line.slice(3);
                const arrow = p.indexOf(' -> ');
                if (arrow >= 0) { p = p.slice(arrow + 4); }          // renamed: take new path
                p = p.replace(/^"(.*)"$/, '$1').replace(/\\/g, '/'); // unquote + normalize
                map[p] = code[0] === ' ' ? code[1] : code[0];
            }
            resolve(map);
        });
    });
}

// ---------------------------------------------------------------------------
// Webview panel controller
// ---------------------------------------------------------------------------

let hookServer: MonitorHookServer | undefined;

export function getHookServer(): MonitorHookServer | undefined { return hookServer; }

export function openClaudeMonitor(context: vscode.ExtensionContext) {
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) { vscode.window.showErrorMessage('Claude Monitor: No workspace folder open.'); return; }
    const cwd = wsFolder.uri.fsPath;
    const dir = projectsDirForWorkspace(cwd);

    const panel = vscode.window.createWebviewPanel(
        'dynoClaudeMonitor', 'Claude Task Monitor',
        vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.webview.html = getHtml();

    // shared live hook server (started lazily, shared across panels)
    if (!hookServer) { hookServer = new MonitorHookServer(); hookServer.start(); }

    let agg: TranscriptAggregator | undefined;
    let selectedFile: string | undefined;     // user-pinned session, else auto (latest)
    let fileWatcher: fs.FSWatcher | undefined;
    let dirWatcher: fs.FSWatcher | undefined;
    let debounce: NodeJS.Timeout | undefined;
    let disposed = false;

    const resolveFile = (): string | undefined => {
        const sessions = listSessions(dir);
        if (selectedFile && sessions.some(s => s.file === selectedFile)) { return selectedFile; }
        return sessions[0]?.file;
    };

    const attachWatcher = (file: string) => {
        if (fileWatcher) { fileWatcher.close(); fileWatcher = undefined; }
        try { fileWatcher = fs.watch(file, () => scheduleUpdate()); } catch { /* */ }
    };

    const pushUpdate = async () => {
        if (disposed) { return; }
        const file = resolveFile();
        if (!file) {
            panel.webview.postMessage({ type: 'state', state: emptyState(cwd, `No Claude transcript found in\n${dir}`) });
            return;
        }
        if (!agg || agg.file !== file) { agg = new TranscriptAggregator(file, cwd); attachWatcher(file); }
        agg.update();

        let mtime = Date.now();
        try { mtime = fs.statSync(file).mtimeMs; } catch { /* */ }

        const git = await gitStatus(cwd);
        const sessions = listSessions(dir).map(s => ({ id: s.id, title: s.title, file: s.file, active: s.file === file }));

        const base = agg.getState(true, mtime);
        const state: MonitorState = {
            ...(base as MonitorState),
            cwd, git, sessions, updatedAt: Date.now(),
            hook: !!hookServer?.isConnected(),
        };
        panel.webview.postMessage({ type: 'state', state });
    };

    const scheduleUpdate = () => {
        if (disposed) { return; }
        if (debounce) { clearTimeout(debounce); }
        debounce = setTimeout(() => { void pushUpdate(); }, 200);
    };

    try { dirWatcher = fs.watch(dir, () => scheduleUpdate()); } catch { /* dir may not exist */ }
    const hookSub = hookServer.onPoke(() => scheduleUpdate());

    panel.webview.onDidReceiveMessage((msg) => {
        if (!msg) { return; }
        if (msg.type === 'ready' || msg.type === 'refresh') { void pushUpdate(); }
        else if (msg.type === 'selectSession') { selectedFile = msg.file || undefined; agg = undefined; void pushUpdate(); }
        else if (msg.type === 'open' && typeof msg.path === 'string') {
            vscode.workspace.openTextDocument(vscode.Uri.file(msg.path))
                .then(doc => vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside))
                .then(undefined, err => vscode.window.showErrorMessage(`Cannot open: ${err.message}`));
        } else if (msg.type === 'reveal' && typeof msg.path === 'string') {
            vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(msg.path));
        }
    }, undefined, context.subscriptions);

    panel.onDidDispose(() => {
        disposed = true;
        if (debounce) { clearTimeout(debounce); }
        fileWatcher?.close(); dirWatcher?.close(); hookSub.dispose();
    }, undefined, context.subscriptions);

    logInfo(`Claude Monitor watching ${dir}`);
    void pushUpdate();
}

function emptyState(cwd: string, error: string): MonitorState {
    return {
        title: '', sessionId: '', gitBranch: '', cwd, model: '',
        files: [], tools: [], activity: [], promptMarks: [],
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0,
        status: { kind: 'idle', label: 'No session' }, git: {}, sessions: [],
        updatedAt: Date.now(), hook: false, error,
    };
}

// ---------------------------------------------------------------------------
// Webview HTML (self-contained: nested squarified treemap + zoomable timeline)
// ---------------------------------------------------------------------------

function getHtml(): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root { color-scheme: light dark; }
  body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground);
    background: var(--vscode-editor-background); margin: 0; padding: 12px; }
  header { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; }
  .muted { color: var(--vscode-descriptionForeground); font-size: 12px; }
  select, button { font-family: inherit; font-size: 12px; }
  select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border, transparent); border-radius: 4px; padding: 2px 6px; max-width: 260px; }
  .badge { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    border-radius: 10px; padding: 1px 8px; font-size: 11px; }
  .pill { border-radius: 10px; padding: 2px 10px; font-size: 11px; font-weight: 600; display: inline-flex; align-items: center; gap: 6px; }
  .pill .dot { width: 8px; height: 8px; border-radius: 50%; }
  .pill.running { background: rgba(55,148,255,.18); color: #3794ff; } .pill.running .dot { background:#3794ff; animation: pulse 1s infinite; }
  .pill.thinking { background: rgba(163,113,247,.18); color: #a371f7; } .pill.thinking .dot { background:#a371f7; animation: pulse 1.4s infinite; }
  .pill.waiting { background: rgba(210,153,34,.2); color: #d29922; } .pill.waiting .dot { background:#d29922; }
  .pill.idle { background: rgba(139,148,158,.2); color: #8b949e; } .pill.idle .dot { background:#8b949e; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.35} }
  .grid { display: grid; grid-template-columns: 1fr 320px; gap: 14px; align-items: start; }
  @media (max-width: 780px) { .grid { grid-template-columns: 1fr; } }
  .card { border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); border-radius: 8px; padding: 10px; }
  .card h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--vscode-descriptionForeground);
    margin: 0 0 8px; display: flex; align-items: center; gap: 8px; }
  .card h2 .sp { flex: 1; }
  #treemap { width: 100%; height: 460px; display: block; }
  .tm-leaf rect { cursor: pointer; }
  .tm-leaf text, .tm-hdr { pointer-events: none; }
  .tl-wrap { overflow-x: auto; overflow-y: hidden; }
  #timeline { height: 64px; display: block; }
  .tl-bar { cursor: pointer; }
  .axis { display: flex; justify-content: space-between; font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
  .tools { display: flex; flex-direction: column; gap: 4px; }
  .tool-row { display: flex; align-items: center; gap: 8px; }
  .tool-row .bar { height: 10px; border-radius: 3px; background: var(--vscode-charts-blue, #3794ff); }
  .tool-row .n { width: 82px; flex: none; } .tool-row .c { width: 32px; text-align: right; flex: none; color: var(--vscode-descriptionForeground); }
  .stats { display: flex; gap: 16px; flex-wrap: wrap; }
  .stat b { font-size: 18px; display: block; } .stat span { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .feed { max-height: 380px; overflow: auto; display: flex; flex-direction: column; gap: 2px; }
  .ev { display: flex; gap: 8px; padding: 3px 4px; border-radius: 4px; align-items: baseline; }
  .ev:hover { background: var(--vscode-list-hoverBackground); }
  .ev .t { color: var(--vscode-descriptionForeground); flex: none; width: 58px; font-variant-numeric: tabular-nums; }
  .ev .k { flex: none; width: 70px; font-weight: 600; }
  .ev .dur { flex: none; width: 44px; text-align: right; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
  .ev .d { color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .empty { color: var(--vscode-descriptionForeground); white-space: pre-wrap; padding: 20px; text-align: center; }
  button.btn { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
    border: none; padding: 3px 10px; border-radius: 4px; cursor: pointer; }
  .seg { display: inline-flex; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3)); border-radius: 5px; overflow: hidden; }
  .seg button { background: transparent; color: var(--vscode-foreground); border: none; padding: 2px 8px; cursor: pointer; }
  .seg button.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .legend { display: flex; gap: 10px; flex-wrap: wrap; font-size: 11px; margin-top: 6px; color: var(--vscode-descriptionForeground); }
  .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
</style>
</head>
<body>
<header>
  <h1>🔍 Claude Task Monitor</h1>
  <span id="pill" class="pill idle"><span class="dot"></span><span id="pill-label">Idle</span></span>
  <span id="hook" class="badge" title="live hook" style="display:none">⚡ live</span>
  <select id="session" title="Chọn session"></select>
  <span class="sp" style="flex:1"></span>
  <span id="model" class="muted"></span>
  <span id="branch" class="badge" style="display:none"></span>
  <span id="updated" class="muted"></span>
  <button class="btn" onclick="vscode.postMessage({type:'refresh'})">Refresh</button>
</header>

<div id="empty" class="empty" style="display:none"></div>

<div id="main">
  <div class="card" style="margin-bottom:14px"><div class="stats" id="stats"></div></div>

  <div class="card" style="margin-bottom:14px">
    <h2>Timeline
      <span class="sp"></span>
      <span class="muted" id="tl-info"></span>
      <span class="seg"><button id="zoom-out">−</button><button id="zoom-reset">reset</button><button id="zoom-in">+</button></span>
    </h2>
    <div class="tl-wrap"><svg id="timeline" preserveAspectRatio="none"></svg></div>
    <div class="axis"><span id="tl-start"></span><span id="tl-end"></span></div>
    <div class="legend" id="tl-legend"></div>
  </div>

  <div class="grid">
    <div class="card">
      <h2>Files touched
        <span class="sp" style="flex:1"></span>
        <span class="seg">
          <button id="m-touch" class="on">touches</button>
          <button id="m-lines">lines</button>
        </span>
      </h2>
      <svg id="treemap" preserveAspectRatio="none"></svg>
      <div class="legend" id="tm-legend"></div>
    </div>
    <div style="display:flex; flex-direction:column; gap:14px;">
      <div class="card">
        <h2>Cost & tokens</h2>
        <div id="cost"></div>
      </div>
      <div class="card">
        <h2>Tool usage</h2>
        <div class="tools" id="tools"></div>
      </div>
      <div class="card">
        <h2>Activity <span class="sp" style="flex:1"></span>
          <select id="filter" title="Lọc theo tool"><option value="">all tools</option></select>
        </h2>
        <div class="feed" id="feed"></div>
      </div>
    </div>
  </div>
</div>

<script>
const vscode = acquireVsCodeApi();
let last = null;
let metric = 'touch';       // 'touch' | 'lines'
let zoom = 1;
let filterTool = '';

function fmt(n){ n=Math.round(n); return n>=1000 ? (n/1000).toFixed(n>=10000?0:1)+'k' : String(n); }
function hhmm(ts){ if(!ts) return ''; const d=new Date(ts); return d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'}); }
function dur(ms){ if(ms<0) return ''; if(ms<1000) return ms+'ms'; if(ms<60000) return (ms/1000).toFixed(1)+'s'; return Math.round(ms/60000)+'m'; }
function escapeHtml(s){ return String(s).replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

const palette = ['#3794ff','#3fb950','#d29922','#a371f7','#f78166','#56d4bb','#db61a2','#e3b341'];
function hashStr(s){ let h=0; for(let i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))>>>0; return h; }
function topDir(rel){ return rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : '(root)'; }
function colorForTop(top){ return palette[hashStr(top) % palette.length]; }
function colorForTool(name){ return palette[hashStr(name) % palette.length]; }

// ---- squarified treemap (returns rects assigned onto items) ----------------
function squarify(items, x, y, w, h){
  const total = items.reduce((s,it)=>s+it.value,0) || 1;
  for(const it of items){ it.area = it.value/total * (w*h); }
  let rx=x, ry=y, rw=w, rh=h, row=[];
  const worst=(row,len)=>{ const s=row.reduce((a,b)=>a+b.area,0), mx=Math.max(...row.map(r=>r.area)), mn=Math.min(...row.map(r=>r.area)); const l2=len*len,s2=s*s; return Math.max((l2*mx)/s2, s2/(l2*mn)); };
  const layoutRow=(row,horizontal)=>{ const s=row.reduce((a,b)=>a+b.area,0);
    if(horizontal){ const rowH=s/rw; let cx=rx; for(const r of row){ const cw=r.area/rowH; r.rect={x:cx,y:ry,w:cw,h:rowH}; cx+=cw; } ry+=rowH; rh-=rowH; }
    else { const rowW=s/rh; let cy=ry; for(const r of row){ const ch=r.area/rowW; r.rect={x:rx,y:cy,w:rowW,h:ch}; cy+=ch; } rx+=rowW; rw-=rowW; } };
  let i=0;
  while(i<items.length){ const horizontal=rw>=rh, len=horizontal?rw:rh, next=items[i];
    if(row.length===0){ row.push(next); i++; continue; }
    if(worst([...row,next],len) <= worst(row,len)){ row.push(next); i++; }
    else { layoutRow(row,horizontal); row=[]; } }
  if(row.length) layoutRow(row, rw>=rh);
}

// ---- nested treemap --------------------------------------------------------
function metricVal(f){ return metric==='lines' ? (f.linesAdded+f.linesRemoved) : f.total; }
function buildTree(files){
  const root={name:'',children:[],map:{},value:0,leaf:false};
  for(const f of files){
    const val=metricVal(f); if(val<=0) continue;
    const parts=f.rel.split('/'); let node=root;
    for(let i=0;i<parts.length;i++){ const p=parts[i], last=i===parts.length-1;
      if(last){ node.children.push({name:p,leaf:true,f,value:val,children:[]}); }
      else { if(!node.map[p]){ const c={name:p,leaf:false,children:[],map:{},value:0}; node.map[p]=c; node.children.push(c);} node=node.map[p]; } }
  }
  return root;
}
function layoutTree(node,x,y,w,h,depth,out){
  const kids=node.children.filter(c=>c.value>0);
  if(!kids.length) return;
  const items=kids.map(c=>({value:c.value, ref:c}));
  squarify(items,x,y,w,h);
  for(const it of items){ const r=it.rect, c=it.ref; if(!r||r.w<2||r.h<2) continue;
    out.push({r,node:c,depth});
    if(!c.leaf){ const hd=(r.w>54&&r.h>26)?15:0, pad=2;
      const ix=r.x+pad, iy=r.y+hd+pad, iw=r.w-2*pad, ih=r.h-hd-2*pad;
      if(iw>4&&ih>4) layoutTree(c,ix,iy,iw,ih,depth+1,out); } }
}
function renderTreemap(st){
  const svg=document.getElementById('treemap'); svg.innerHTML='';
  const legend=document.getElementById('tm-legend');
  const W=svg.clientWidth||600, H=460; svg.setAttribute('viewBox','0 0 '+W+' '+H);
  const root=buildTree(st.files);
  if(!root.children.length){ legend.innerHTML='<span>Chưa có file nào ('+(metric==='lines'?'chưa có dòng thay đổi':'')+')</span>'; return; }
  const out=[]; layoutTree(root,0,0,W,H,0,out);
  const ns='http://www.w3.org/2000/svg';
  for(const cell of out){ const {r,node}=cell;
    if(node.leaf){
      const f=node.f, g=document.createElementNS(ns,'g'); g.setAttribute('class','tm-leaf');
      const rect=document.createElementNS(ns,'rect');
      rect.setAttribute('x',r.x); rect.setAttribute('y',r.y);
      rect.setAttribute('width',Math.max(0,r.w)); rect.setAttribute('height',Math.max(0,r.h));
      rect.setAttribute('fill',colorForTop(topDir(f.rel))); rect.setAttribute('fill-opacity','0.85');
      rect.setAttribute('stroke','var(--vscode-editor-background)'); rect.setAttribute('stroke-width','1');
      const gs=st.git[f.rel];
      rect.innerHTML='<title>'+escapeHtml(f.rel)+'\\n'+f.total+' touches · +'+f.linesAdded+'/-'+f.linesRemoved+' lines'+(gs?(' · git '+gs):'')+'\\nclick: mở · shift+click: reveal</title>';
      rect.addEventListener('click',(e)=> vscode.postMessage({type: e.shiftKey?'reveal':'open', path: f.path}));
      g.appendChild(rect);
      if(r.w>44 && r.h>16){ const t=document.createElementNS(ns,'text');
        t.setAttribute('x',r.x+4); t.setAttribute('y',r.y+13); t.setAttribute('fill','#fff'); t.setAttribute('font-size','10');
        const nm=node.name; t.textContent = nm.length*6>r.w-8 ? nm.slice(0,Math.max(1,Math.floor((r.w-8)/6)))+'…' : nm; g.appendChild(t); }
      if(gs && r.w>16 && r.h>16){ const b=document.createElementNS(ns,'text');
        b.setAttribute('x',r.x+r.w-4); b.setAttribute('y',r.y+r.h-4); b.setAttribute('text-anchor','end');
        b.setAttribute('font-size','9'); b.setAttribute('font-weight','700');
        b.setAttribute('fill', gs==='M'?'#d29922':gs==='A'||gs==='?'?'#3fb950':gs==='D'?'#f85149':'#8b949e');
        b.textContent=gs; b.setAttribute('class','tm-hdr'); g.appendChild(b); }
      svg.appendChild(g);
    } else {
      const rect=document.createElementNS(ns,'rect');
      rect.setAttribute('x',r.x); rect.setAttribute('y',r.y); rect.setAttribute('width',Math.max(0,r.w)); rect.setAttribute('height',Math.max(0,r.h));
      rect.setAttribute('fill','none'); rect.setAttribute('stroke',colorForTop(node.name)); rect.setAttribute('stroke-opacity','0.5'); rect.setAttribute('stroke-width','1');
      svg.appendChild(rect);
      if(r.w>54 && r.h>26){ const t=document.createElementNS(ns,'text');
        t.setAttribute('x',r.x+4); t.setAttribute('y',r.y+11); t.setAttribute('font-size','10'); t.setAttribute('font-weight','600');
        t.setAttribute('fill','var(--vscode-descriptionForeground)'); t.setAttribute('class','tm-hdr');
        t.textContent = node.name.length*6>r.w-8 ? node.name.slice(0,Math.max(1,Math.floor((r.w-8)/6)))+'…' : node.name; svg.appendChild(t); }
    }
  }
  // legend: top dirs
  const dt={}; for(const f of st.files){ const v=metricVal(f); if(v>0){ const t=topDir(f.rel); dt[t]=(dt[t]||0)+v; } }
  legend.innerHTML = Object.entries(dt).sort((a,b)=>b[1]-a[1]).slice(0,8)
    .map(([d,c])=>'<span><i style="background:'+colorForTop(d)+'"></i>'+d+' ('+fmt(c)+')</span>').join('')
    + '<span>· click mở · shift+click reveal</span>';
}

// ---- zoomable timeline -----------------------------------------------------
function renderTimeline(st){
  const svg=document.getElementById('timeline'); svg.innerHTML='';
  const wrap=svg.parentElement, legend=document.getElementById('tl-legend');
  const evs=st.activity.filter(a=>a.ts>0).slice().sort((a,b)=>a.ts-b.ts);
  document.getElementById('tl-start').textContent=''; document.getElementById('tl-end').textContent='';
  document.getElementById('tl-info').textContent=''; legend.innerHTML='';
  if(!evs.length){ svg.setAttribute('viewBox','0 0 600 64'); svg.setAttribute('width','600'); return; }
  const baseW=Math.max(wrap.clientWidth||600, 300), W=Math.round(baseW*zoom), H=64;
  svg.setAttribute('viewBox','0 0 '+W+' '+H); svg.setAttribute('width',W); svg.setAttribute('height',H);
  const min=evs[0].ts, max=evs[evs.length-1].ts, span=Math.max(1,max-min);
  const X=ts=> (min===max? W/2 : ((ts-min)/span)*(W-6));
  const ns='http://www.w3.org/2000/svg';
  // prompt markers
  for(const pm of (st.promptMarks||[])){ if(pm<min||pm>max) continue;
    const ln=document.createElementNS(ns,'line'); const x=X(pm);
    ln.setAttribute('x1',x); ln.setAttribute('x2',x); ln.setAttribute('y1',0); ln.setAttribute('y2',H);
    ln.setAttribute('stroke','var(--vscode-descriptionForeground)'); ln.setAttribute('stroke-dasharray','2,3'); ln.setAttribute('stroke-opacity','0.6');
    ln.innerHTML='<title>user prompt '+hhmm(pm)+'</title>'; svg.appendChild(ln); }
  // bars, width by duration
  for(const a of evs){ const x=X(a.ts);
    let w=3; if(a.durationMs>0){ w=Math.max(3, (a.durationMs/span)*(W-6)); }
    const rect=document.createElementNS(ns,'rect'); rect.setAttribute('class','tl-bar');
    rect.setAttribute('x',x); rect.setAttribute('y',6); rect.setAttribute('width',w); rect.setAttribute('height',H-12);
    rect.setAttribute('fill',colorForTool(a.tool)); rect.setAttribute('rx','1'); rect.setAttribute('fill-opacity','0.85');
    rect.innerHTML='<title>'+hhmm(a.ts)+'  '+a.tool+(a.durationMs>=0?(' · '+dur(a.durationMs)):'')+'\\n'+escapeHtml(a.detail)+'</title>';
    rect.addEventListener('click',()=>{ if(a.detail && a.detail.includes('/')||a.detail.includes('\\\\')) vscode.postMessage({type:'open',path:a.detail}); });
    svg.appendChild(rect); }
  document.getElementById('tl-start').textContent=hhmm(min);
  document.getElementById('tl-end').textContent=hhmm(max);
  const mins=Math.round((max-min)/60000);
  document.getElementById('tl-info').textContent=(mins>0?mins+' phút · ':'')+evs.length+' calls · '+(st.promptMarks||[]).length+' prompts · zoom '+zoom.toFixed(1)+'×';
  const cnt={}; for(const a of evs) cnt[a.tool]=(cnt[a.tool]||0)+1;
  legend.innerHTML=Object.entries(cnt).sort((a,b)=>b[1]-a[1]).map(([t,c])=>'<span><i style="background:'+colorForTool(t)+'"></i>'+t+' ('+c+')</span>').join('');
}

function renderTools(tools){
  const el=document.getElementById('tools'); el.innerHTML='';
  const max=Math.max(1,...tools.map(t=>t.count));
  for(const t of tools){ const row=document.createElement('div'); row.className='tool-row';
    row.innerHTML='<span class="n">'+t.name+'</span><div class="bar" style="width:'+(t.count/max*150)+'px;background:'+colorForTool(t.name)+'"></div><span class="c">'+t.count+'</span>';
    el.appendChild(row); }
}
function renderFeed(activity){
  const el=document.getElementById('feed'); el.innerHTML='';
  for(const a of activity){ if(filterTool && a.tool!==filterTool) continue;
    const ev=document.createElement('div'); ev.className='ev';
    ev.innerHTML='<span class="t">'+hhmm(a.ts)+'</span><span class="k">'+a.tool+'</span><span class="dur">'+dur(a.durationMs)+'</span><span class="d">'+escapeHtml(a.detail)+'</span>';
    el.appendChild(ev); }
}
function renderCost(st){
  const t=st.tokens, el=document.getElementById('cost');
  el.innerHTML =
    '<div style="font-size:22px;font-weight:700">$'+st.costUsd.toFixed(3)+'</div>'+
    '<div class="muted" style="margin-bottom:6px">ước tính · '+(st.model||'?')+'</div>'+
    row('output', t.output) + row('input', t.input) + row('cache write', t.cacheWrite) + row('cache read', t.cacheRead);
  function row(l,v){ return '<div style="display:flex;justify-content:space-between"><span class="muted">'+l+'</span><span>'+fmt(v)+'</span></div>'; }
}
function renderStats(st){
  const el=document.getElementById('stats'), t=st.tokens;
  el.innerHTML = stat(st.files.length,'files') + stat(st.tools.reduce((s,x)=>s+x.count,0),'tool calls')
    + stat((st.promptMarks||[]).length,'prompts') + stat(fmt(t.output),'out tokens') + stat('$'+st.costUsd.toFixed(2),'cost est');
  function stat(v,l){ return '<div class="stat"><b>'+v+'</b><span>'+l+'</span></div>'; }
}
function renderSessions(st){
  const sel=document.getElementById('session'); const cur=sel.value;
  sel.innerHTML='';
  for(const s of st.sessions){ const o=document.createElement('option'); o.value=s.file;
    o.textContent=(s.active?'● ':'')+(s.title|| s.id.slice(0,8)); if(s.active) o.selected=true; sel.appendChild(o); }
}
function renderFilter(st){
  const sel=document.getElementById('filter'); const cur=sel.value;
  sel.innerHTML='<option value="">all tools</option>';
  for(const t of st.tools){ const o=document.createElement('option'); o.value=t.name; o.textContent=t.name+' ('+t.count+')'; sel.appendChild(o); }
  sel.value = filterTool;
}

function render(st){
  const empty=document.getElementById('empty'), main=document.getElementById('main');
  if(st.error){ empty.style.display='block'; empty.textContent=st.error; main.style.display='none';
    // still show session picker so user can switch
  } else { empty.style.display='none'; main.style.display='block'; }
  const pill=document.getElementById('pill'); pill.className='pill '+st.status.kind;
  document.getElementById('pill-label').textContent=st.status.label;
  document.getElementById('hook').style.display = st.hook ? 'inline-block':'none';
  document.getElementById('model').textContent = st.model||'';
  const b=document.getElementById('branch'); if(st.gitBranch){ b.style.display='inline-block'; b.textContent='⑂ '+st.gitBranch; } else b.style.display='none';
  document.getElementById('updated').textContent='cập nhật '+hhmm(st.updatedAt);
  renderSessions(st);
  if(st.error) return;
  renderStats(st); renderCost(st); renderTimeline(st); renderTreemap(st); renderTools(st.tools); renderFilter(st); renderFeed(st.activity);
}

// ---- controls --------------------------------------------------------------
document.getElementById('session').addEventListener('change', e=> vscode.postMessage({type:'selectSession', file:e.target.value}));
document.getElementById('filter').addEventListener('change', e=>{ filterTool=e.target.value; if(last) renderFeed(last.activity); });
document.getElementById('m-touch').addEventListener('click', ()=> setMetric('touch'));
document.getElementById('m-lines').addEventListener('click', ()=> setMetric('lines'));
function setMetric(m){ metric=m; document.getElementById('m-touch').classList.toggle('on',m==='touch'); document.getElementById('m-lines').classList.toggle('on',m==='lines'); if(last) renderTreemap(last); }
document.getElementById('zoom-in').addEventListener('click', ()=>{ zoom=Math.min(20,zoom*1.5); if(last) renderTimeline(last); });
document.getElementById('zoom-out').addEventListener('click', ()=>{ zoom=Math.max(1,zoom/1.5); if(last) renderTimeline(last); });
document.getElementById('zoom-reset').addEventListener('click', ()=>{ zoom=1; if(last) renderTimeline(last); });
document.querySelector('.tl-wrap').addEventListener('wheel', e=>{ if(e.ctrlKey||e.metaKey){ e.preventDefault(); zoom=Math.min(20,Math.max(1, zoom*(e.deltaY<0?1.2:0.83))); if(last) renderTimeline(last); } }, {passive:false});

window.addEventListener('message', e=>{ if(e.data?.type==='state'){ last=e.data.state; render(last); } });
window.addEventListener('resize', ()=>{ if(last){ renderTimeline(last); renderTreemap(last); } });
vscode.postMessage({type:'ready'});
</script>
</body>
</html>`;
}
