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
 * The main visual is a hub-and-spoke diagram: the central hub is the main
 * (orchestrator) agent; each spoke is a subagent invoked via the Task tool.
 * Files touched are shown as a compact list beneath it.
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

/** One invocation of a subagent via the Task tool (a spoke off the main agent). */
interface AgentRun {
    id: string;
    type: string;        // subagent_type, e.g. "Explore", "general-purpose"
    desc: string;
    ts: number;
    durationMs: number;  // -1 = still running
    running: boolean;
    failed: boolean;     // tool_result for this Task came back with is_error
    toolCount: number;   // tools the subagent ran (from Task result summary, if present)
    tokens: number;      // subagent tokens (from Task result summary, if present)
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
    promptMarks: any[];               // user prompts (timestamps or {ts, text} objects)
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
    costUsd: number;
    status: { kind: 'running' | 'thinking' | 'idle' | 'waiting'; label: string; tool?: string };
    models: { name: string; messages: number; output: number }[];
    agents: { type: string; count: number; lastDesc: string; running: boolean }[];
    agentRuns: AgentRun[];
    mainToolCalls: number;
    sidechainToolCalls: number;
    sidechainMsgs: number;
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
function extractPromptText(content: any): string {
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        const textObj = content.find((c: any) => c.type === 'text');
        if (textObj && textObj.text) {
            return String(textObj.text);
        }
    }
    return '';
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
    private promptMarks: any[] = [];
    tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

    // model + subagent tracking
    private models = new Map<string, { messages: number; output: number }>();
    private agents = new Map<string, { count: number; lastDesc: string; lastId: string }>();
    private agentRuns = new Map<string, AgentRun>();     // keyed by Task tool_use id
    private sidechainMsgs = 0;
    private mainToolCalls = 0;
    private sidechainToolCalls = 0;

    // rolling record of the very last meaningful event, for status detection
    private lastToolUsePending: { id: string; tool: string; ts: number } | undefined;
    private pendingIds = new Set<string>();

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
        this.models.clear(); this.agents.clear(); this.agentRuns.clear();
        this.sidechainMsgs = 0; this.mainToolCalls = 0; this.sidechainToolCalls = 0;
        this.lastToolUsePending = undefined; this.pendingIds.clear();
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
            if (m.model) {
                if (!o.isSidechain) { this.model = m.model; }   // main-chain model shown in header
                const mm = this.models.get(m.model) || { messages: 0, output: 0 };
                mm.messages++; mm.output += m.usage?.output_tokens || 0;
                this.models.set(m.model, mm);
            }
            if (o.isSidechain) { this.sidechainMsgs++; }
            if (m.usage) {
                this.tokens.input += m.usage.input_tokens || 0;
                this.tokens.output += m.usage.output_tokens || 0;
                this.tokens.cacheRead += m.usage.cache_read_input_tokens || 0;
                this.tokens.cacheWrite += m.usage.cache_creation_input_tokens || 0;
            }
            if (Array.isArray(m.content)) {
                for (const c of m.content) {
                    if (c.type !== 'tool_use') { continue; }
                    if (o.isSidechain) { this.sidechainToolCalls++; } else { this.mainToolCalls++; }
                    this.onToolUse(c, toTime(o.timestamp), !!o.isSidechain);
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
                        this.onToolResult(c.tool_use_id, ts, o.toolUseResult, !!c.is_error);
                    }
                }
            }
            // a genuine user prompt (typed text, not a tool result)
            if (!isToolResult && ts && o.promptSource !== 'hook') {
                const text = extractPromptText(content);
                const hasText = text.trim().length > 0 || (Array.isArray(content) && content.some((c: any) => c.type === 'image'));
                if (hasText) { this.promptMarks.push({ ts, text: text.trim() }); }
            }
        }
    }

    private onToolUse(c: any, ts: number, isSidechain: boolean) {
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
        } else if (name === 'Task') {
            const agentType = String(input.subagent_type || 'agent');
            const desc = String(input.description || input.prompt || '').slice(0, 100);
            const a = this.agents.get(agentType) || { count: 0, lastDesc: '', lastId: '' };
            a.count++; a.lastDesc = desc; a.lastId = c.id || '';
            this.agents.set(agentType, a);
            if (!isSidechain && c.id) {   // a spoke off the main agent
                this.agentRuns.set(c.id, { id: c.id, type: agentType, desc, ts, durationMs: -1, running: true, failed: false, toolCount: 0, tokens: 0 });
            }
            detail = `${agentType}: ${desc}`;
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
            this.pendingIds.add(c.id);
        }
    }

    private onToolResult(toolUseId: string, ts: number, toolUseResult: any, isError: boolean) {
        if (toolUseId) { this.pendingIds.delete(toolUseId); }
        if (toolUseId && this.lastToolUsePending?.id === toolUseId) { this.lastToolUsePending = undefined; }
        const start = toolUseId ? this.toolStart.get(toolUseId) : undefined;
        const item = toolUseId ? this.activityById.get(toolUseId) : undefined;
        if (item && start && ts >= start.ts) { item.durationMs = ts - start.ts; }

        // a subagent (Task) finished — complete its spoke
        const run = toolUseId ? this.agentRuns.get(toolUseId) : undefined;
        if (run) {
            run.running = false;
            run.failed = isError;
            if (start && ts >= start.ts) { run.durationMs = ts - start.ts; }
            if (toolUseResult && typeof toolUseResult === 'object') {
                run.toolCount = Number(toolUseResult.totalToolUseCount ?? toolUseResult.toolUseCount ?? run.toolCount) || 0;
                run.tokens = Number(toolUseResult.totalTokens ?? toolUseResult.usage?.output_tokens ?? run.tokens) || 0;
            }
        }

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

        const models = [...this.models.entries()]
            .map(([name, v]) => ({ name, messages: v.messages, output: v.output }))
            .sort((a, b) => b.messages - a.messages);
        const agents = [...this.agents.entries()]
            .map(([type, v]) => ({ type, count: v.count, lastDesc: v.lastDesc, running: !!v.lastId && this.pendingIds.has(v.lastId) }))
            .sort((a, b) => Number(b.running) - Number(a.running) || b.count - a.count);

        const agentRuns = [...this.agentRuns.values()].sort((a, b) => a.ts - b.ts);

        return {
            title: this.title, sessionId: this.sessionId, gitBranch: this.gitBranch, model: this.model,
            files, tools, activity, promptMarks: this.promptMarks.slice(),
            tokens: { ...this.tokens }, costUsd: cost, status,
            models, agents, agentRuns,
            mainToolCalls: this.mainToolCalls, sidechainToolCalls: this.sidechainToolCalls,
            sidechainMsgs: this.sidechainMsgs,
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
        status: { kind: 'idle', label: 'No session' },
        models: [], agents: [], agentRuns: [], mainToolCalls: 0, sidechainToolCalls: 0, sidechainMsgs: 0,
        git: {}, sessions: [],
        updatedAt: Date.now(), hook: false, error,
    };
}

// ---------------------------------------------------------------------------
// Webview HTML (self-contained: hub-and-spoke agent graph + zoomable timeline)
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
  .ag-pulse { animation: pulse 1.2s infinite; }
  .ag-flow { animation: flow 0.6s linear infinite; }
  @keyframes flow { to { stroke-dashoffset: -18; } }
  .grid { display: grid; grid-template-columns: 1fr 320px; gap: 14px; align-items: start; }
  @media (max-width: 780px) { .grid { grid-template-columns: 1fr; } }
  .top-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; margin-bottom: 14px; }
  .card { border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); border-radius: 8px; padding: 10px; }
  .card h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--vscode-descriptionForeground);
    margin: 0 0 8px; display: flex; align-items: center; gap: 8px; }
  .card h2 .sp { flex: 1; }
  #agraph { width: 100%; height: 460px; display: block; }
  .ag-node { cursor: pointer; }
  .ag-node:hover circle { stroke-width: 2.5; }
  .fl { display: flex; gap: 6px; align-items: baseline; padding: 2px 4px; border-radius: 4px; cursor: pointer; }
  .fl:hover { background: var(--vscode-list-hoverBackground); }
  .fl .g { flex: none; width: 14px; font-weight: 700; font-size: 10px; }
  .fl .p { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .fl .n { flex: none; color: var(--vscode-descriptionForeground); font-size: 11px; }
  .tl-wrap { overflow-x: auto; overflow-y: hidden; }
  #timeline { height: 64px; display: block; }
  .tl-bar { cursor: pointer; }
  .axis { display: flex; justify-content: space-between; font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
  .tools { display: flex; flex-direction: column; gap: 4px; }
  .tool-row { display: flex; align-items: center; gap: 8px; justify-content: space-between; }
  .tool-row .bar-wrap { flex: 1; height: 10px; display: flex; align-items: center; min-width: 40px; }
  .tool-row .bar { height: 10px; border-radius: 3px; background: var(--vscode-charts-blue, #3794ff); }
  .tool-row .n { width: 110px; flex: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tool-row .c { width: 32px; text-align: right; flex: none; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
  .stats { display: flex; gap: 16px; flex-wrap: wrap; }
  .stat b { font-size: 18px; display: block; } .stat span { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .feed { max-height: 380px; overflow: auto; display: flex; flex-direction: column; gap: 2px; }
  .ev { display: flex; gap: 8px; padding: 3px 4px; border-radius: 4px; align-items: baseline; }
  .ev:hover { background: var(--vscode-list-hoverBackground); }
  .ev .t { color: var(--vscode-descriptionForeground); flex: none; width: 75px; font-variant-numeric: tabular-nums; }
  .ev .k { flex: none; width: 85px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
  .help { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; border-radius: 50%;
    border: 1px solid var(--vscode-descriptionForeground); color: var(--vscode-descriptionForeground); font-size: 9px;
    font-weight: 700; cursor: pointer; user-select: none; flex: none; opacity: .7; }
  .help:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.2)); }
  #tip { position: fixed; z-index: 1000; max-width: 300px; padding: 8px 10px; border-radius: 6px; font-size: 12px; line-height: 1.45;
    background: var(--vscode-editorHoverWidget-background, #252526); color: var(--vscode-editorHoverWidget-foreground, #ccc);
    border: 1px solid var(--vscode-editorHoverWidget-border, rgba(128,128,128,.4)); box-shadow: 0 4px 14px rgba(0,0,0,.4); display: none; }
  .turn { margin-bottom: 12px; border-left: 2px solid var(--vscode-panel-border, rgba(128,128,128,.3)); padding-left: 10px; }
  .turn-header { display: flex; gap: 8px; align-items: baseline; margin-bottom: 6px; font-weight: 600; color: var(--vscode-foreground); }
  .turn-num { color: var(--vscode-textLink-foreground, #3794ff); font-size: 11px; text-transform: uppercase; font-weight: 700; flex: none; }
  .turn-time { color: var(--vscode-descriptionForeground); font-size: 11px; font-variant-numeric: tabular-nums; flex: none; }
  .turn-text { color: var(--vscode-foreground); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; font-weight: normal; opacity: 0.85; }
  .turn-body { display: flex; flex-direction: column; gap: 3px; }
</style>
</head>
<body>
<header>
  <h1>🔍 Claude Task Monitor</h1>
  <span id="pill" class="pill idle"><span class="dot"></span><span id="pill-label">Idle</span></span>
  <span class="help" data-tip="Trạng thái hiện tại của Claude: Running = đang chạy tool, Thinking = vừa hoạt động (file transcript mới đổi), Waiting = tool treo/chờ phê duyệt (>45s), Idle = không hoạt động. Bên cạnh: model chính, session, nhánh git, ⚡live = hook real-time đang bật.">?</span>
  <span id="hook" class="badge" title="live hook" style="display:none">⚡ live</span>
  <select id="session" title="Chọn session"></select>
  <span class="sp" style="flex:1"></span>
  <span id="model" class="muted"></span>
  <span id="branch" class="badge" style="display:none"></span>
  <span id="updated" class="muted"></span>
  <button class="btn" onclick="vscode.postMessage({type:'refresh'})">Refresh</button>
</header>

<div id="tip"></div>
<div id="empty" class="empty" style="display:none"></div>

<div id="main">
  <div class="top-grid">
    <div class="card">
      <h2>Cost & tokens <span class="help" data-tip="Chi phí ước tính của session, tính từ token đã dùng nhân đơn giá theo model. output/input = token sinh ra/nhận vào. cache write/read = token ghi/đọc từ prompt cache (rẻ hơn nhiều). Đây là ƯỚC TÍNH theo bảng giá tham khảo, không phải hóa đơn thật.">?</span></h2>
      <div id="cost"></div>
    </div>
    <div class="card">
      <h2>Models & agents <span class="help" data-tip="Model nào đang thực thi và subagent nào được spawn. 'models' = các model xuất hiện trong session (kèm số message + output token). 'subagents' = các agent con Claude gọi qua tool Task (vd Explore, general-purpose); chấm xanh nhấp nháy = đang chạy. side-msgs = số message chạy trong nhánh subagent.">?</span></h2>
      <div id="agents"></div>
    </div>
    <div class="card">
      <h2>Tổng quan <span class="help" data-tip="Số liệu tổng của session hiện tại: số file Claude đã đụng vào, tổng số lần gọi tool, số prompt bạn đã gửi, và các thông tin thống kê khác.">?</span></h2>
      <div id="stats" style="display:flex; flex-direction:column; gap:4px;"></div>
    </div>
  </div>

  <div class="card" style="margin-bottom:14px">
    <h2>Timeline <span class="help" data-tip="Trục thời gian các lần gọi tool. Mỗi vạch = 1 tool call, đặt theo thời điểm gọi, màu theo loại tool. Độ RỘNG vạch = thời gian tool chạy. Đường kẻ đứt = mỗi lần bạn gửi prompt. Ctrl+lăn chuột hoặc nút +/− để zoom.">?</span>
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
      <h2>Agent orchestration <span class="help" data-tip="Sơ đồ hub-and-spoke: vòng tròn giữa là AGENT CHÍNH (orchestrator, chạy model chính). Mỗi nhánh toả ra = 1 lần agent chính gọi subagent qua tool Task. Vòng ngoài của node = màu theo loại subagent; màu bên trong = trạng thái (xanh dương nhấp nháy = đang chạy, xanh lá = xong, đỏ + dấu ! = lỗi). Node càng to = subagent dùng càng nhiều tool. Hover để xem mô tả, thời gian, số tool và token. Danh sách file gom vào mục 'Files touched' phía dưới.">?</span>
        <span class="sp" style="flex:1"></span>
        <span class="muted" id="ag-info"></span>
      </h2>
      <svg id="agraph" preserveAspectRatio="xMidYMid meet"></svg>
      <div class="legend" id="ag-legend"></div>
      <details style="margin-top:8px">
        <summary class="muted" style="cursor:pointer">Files touched (<span id="files-count">0</span>)</summary>
        <div id="files-list" style="margin-top:6px; max-height:160px; overflow:auto; display:flex; flex-direction:column; gap:2px;"></div>
      </details>
    </div>
    <div style="display:flex; flex-direction:column; gap:14px;">
      <div class="card">
        <h2>Tool usage <span class="help" data-tip="Tổng số lần mỗi loại tool được gọi trong session (Read, Edit, Bash, Grep, Task...). Thanh dài = dùng nhiều.">?</span></h2>
        <div class="tools" id="tools"></div>
      </div>
      <div class="card">
        <h2>Activity <span class="help" data-tip="Dòng thời gian chi tiết từng tool call (mới nhất trên cùng): giờ gọi, tên tool, thời gian chạy, và mục tiêu (file/lệnh/pattern). Dùng dropdown để lọc theo 1 tool.">?</span><span class="sp" style="flex:1"></span>
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
let zoom = 1;
let filterTool = '';

function fmt(n){ n=Math.round(n); return n>=1000 ? (n/1000).toFixed(n>=10000?0:1)+'k' : String(n); }
function hhmm(ts){ if(!ts) return ''; const d=new Date(ts); return d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'}); }
function dur(ms){ if(ms<0) return ''; if(ms<1000) return ms+'ms'; if(ms<60000) return (ms/1000).toFixed(1)+'s'; return Math.round(ms/60000)+'m'; }
function escapeHtml(s){ return String(s).replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

const palette = ['#3794ff','#3fb950','#d29922','#a371f7','#f78166','#56d4bb','#db61a2','#e3b341'];
function hashStr(s){ let h=0; for(let i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))>>>0; return h; }
function colorForTool(name){ return palette[hashStr(name) % palette.length]; }
function gitColor(gs){ return gs==='M'?'#d29922':(gs==='A'||gs==='?')?'#3fb950':gs==='D'?'#f85149':'var(--vscode-descriptionForeground)'; }

// ---- hub-and-spoke agent orchestration diagram -----------------------------
function svgEl(ns,tag,attrs){ const e=document.createElementNS(ns,tag); for(const k in attrs) e.setAttribute(k,attrs[k]); return e; }
function runStatus(r){ return r.running ? 'running' : r.failed ? 'failed' : 'done'; }
const STATUS_COLOR = { running:'#3794ff', failed:'#f85149', done:'#3fb950' };
function statusLabel(r){ return r.running ? 'running…' : r.failed ? 'failed · '+dur(r.durationMs) : 'done · '+dur(r.durationMs); }

function renderAgentGraph(st){
  const svg=document.getElementById('agraph'); svg.innerHTML='';
  const legend=document.getElementById('ag-legend'); legend.innerHTML='';
  const ns='http://www.w3.org/2000/svg';
  const W=svg.clientWidth||600, H=460; svg.setAttribute('viewBox','0 0 '+W+' '+H);
  const cx=W/2, cy=H/2;
  const runs=(st.agentRuns||[]).slice();
  const anyRunning=runs.some(r=>r.running);

  document.getElementById('ag-info').textContent =
    runs.length+' subagent'+(runs.length===1?'':'s')+' · main tools '+(st.mainToolCalls||0)+' · sub tools '+(st.sidechainToolCalls||0);

  // edges first (under nodes)
  const n=runs.length;
  const ringR=Math.max(90, Math.min(W,H)/2 - 90);
  const positions=runs.map((r,i)=>{ const ang=-Math.PI/2 + (n? 2*Math.PI*i/n : 0); return {x:cx+ringR*Math.cos(ang), y:cy+ringR*Math.sin(ang)}; });
  for(let i=0;i<runs.length;i++){ const p=positions[i], r=runs[i], sc=STATUS_COLOR[runStatus(r)];
    const line=svgEl(ns,'line',{x1:cx,y1:cy,x2:p.x,y2:p.y,stroke:sc,'stroke-opacity':r.running?'0.9':r.failed?'0.7':'0.45','stroke-width':r.running?'2.5':'1.5'});
    if(r.running){ line.setAttribute('stroke-dasharray','5,4'); line.setAttribute('class','ag-flow'); }
    svg.appendChild(line);
  }

  // spoke nodes: outer ring = subagent type color, fill/inner = run status (running/failed/done)
  for(let i=0;i<runs.length;i++){ const p=positions[i], r=runs[i], sc=STATUS_COLOR[runStatus(r)];
    const rad=Math.max(16, Math.min(36, 16 + (r.toolCount||0)*1.4));
    const g=svgEl(ns,'g',{class:'ag-node'});
    const ring=svgEl(ns,'circle',{cx:p.x,cy:p.y,r:rad+3,fill:'none',stroke:colorForTool(r.type),'stroke-width':'2','stroke-opacity':'0.6'});
    g.appendChild(ring);
    const circ=svgEl(ns,'circle',{cx:p.x,cy:p.y,r:rad,fill:sc,'fill-opacity':r.running?'0.85':r.failed?'0.55':'0.35',stroke:sc,'stroke-width':r.running||r.failed?'3':'1.5'});
    if(r.running){ circ.setAttribute('class','ag-pulse'); }
    circ.innerHTML='<title>'+escapeHtml(r.type)+' · '+runStatus(r)+'\\n'+escapeHtml(r.desc||'')+'\\n'+statusLabel(r)+(r.toolCount?(' · '+r.toolCount+' tools'):'')+(r.tokens?(' · '+fmt(r.tokens)+' tok'):'')+'</title>';
    g.appendChild(circ);
    if(r.failed){ const x=svgEl(ns,'text',{x:p.x,y:p.y+4,'text-anchor':'middle','font-size':Math.min(16,rad)+'','font-weight':'700',fill:'#fff'}); x.textContent='!'; g.appendChild(x); }
    // type label under node
    const t=svgEl(ns,'text',{x:p.x,y:p.y+rad+16,'text-anchor':'middle','font-size':'11','font-weight':'600',fill:'var(--vscode-foreground)'});
    t.textContent=r.type.length>16?r.type.slice(0,15)+'…':r.type; g.appendChild(t);
    const t2=svgEl(ns,'text',{x:p.x,y:p.y+rad+29,'text-anchor':'middle','font-size':'10',fill:sc});
    t2.textContent=statusLabel(r); g.appendChild(t2);
    svg.appendChild(g);
  }

  // hub (main agent) on top
  const hubR=44;
  const hub=svgEl(ns,'circle',{cx,cy,r:hubR,fill:'var(--vscode-editor-background)',stroke:'#3794ff','stroke-width':anyRunning?'3':'2'});
  if(anyRunning){ hub.setAttribute('class','ag-pulse'); }
  svg.appendChild(hub);
  const h1=svgEl(ns,'text',{x:cx,y:cy-4,'text-anchor':'middle','font-size':'12','font-weight':'700',fill:'var(--vscode-foreground)'});
  h1.textContent='main agent'; svg.appendChild(h1);
  const h2=svgEl(ns,'text',{x:cx,y:cy+11,'text-anchor':'middle','font-size':'9',fill:'var(--vscode-descriptionForeground)'});
  h2.textContent=(st.model||'?').replace('claude-',''); svg.appendChild(h2);

  if(!runs.length){
    const t=svgEl(ns,'text',{x:cx,y:cy+hubR+24,'text-anchor':'middle','font-size':'12',fill:'var(--vscode-descriptionForeground)'});
    t.textContent='Agent chính đang tự thực thi — chưa gọi subagent (Task) nào'; svg.appendChild(t);
  }

  // legend: run status + subagent types (ring color)
  const byStatus={running:0,failed:0,done:0}; for(const r of runs) byStatus[runStatus(r)]++;
  const byType={}; for(const r of runs){ byType[r.type]=(byType[r.type]||0)+1; }
  legend.innerHTML =
    '<span><i style="background:'+STATUS_COLOR.running+'"></i>running ('+byStatus.running+')</span>'+
    '<span><i style="background:'+STATUS_COLOR.done+'"></i>done ('+byStatus.done+')</span>'+
    '<span><i style="background:'+STATUS_COLOR.failed+'"></i>failed ('+byStatus.failed+')</span>'+
    Object.entries(byType).sort((a,b)=>b[1]-a[1]).map(([t,c])=>'<span><i style="background:'+colorForTool(t)+'"></i>'+t+' ('+c+')</span>').join('')
    + '<span>· vòng ngoài = loại subagent · màu trong = trạng thái · node to = nhiều tool</span>';
}

function renderFilesList(st){
  document.getElementById('files-count').textContent=String(st.files.length);
  const el=document.getElementById('files-list'); el.innerHTML='';
  for(const f of st.files.slice(0,200)){ const gs=st.git[f.rel]||'';
    const row=document.createElement('div'); row.className='fl'; row.title='click: mở · shift+click: reveal';
    row.innerHTML='<span class="g" style="color:'+gitColor(gs)+'">'+gs+'</span>'+
      '<span class="p">'+escapeHtml(f.rel)+'</span>'+
      '<span class="n">'+f.total+'× +'+f.linesAdded+'/-'+f.linesRemoved+'</span>';
    row.addEventListener('click',(e)=> vscode.postMessage({type:e.shiftKey?'reveal':'open', path:f.path}));
    el.appendChild(row);
  }
  if(!st.files.length){ el.innerHTML='<span class="muted">Chưa có file nào được Read/Edit/Write</span>'; }
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
  for(const pm of (st.promptMarks||[])){
    const pmTs = typeof pm === 'object' && pm !== null ? pm.ts : pm;
    const pmText = typeof pm === 'object' && pm !== null ? pm.text : '';
    if(pmTs<min||pmTs>max) continue;
    const ln=document.createElementNS(ns,'line'); const x=X(pmTs);
    ln.setAttribute('x1',x); ln.setAttribute('x2',x); ln.setAttribute('y1',0); ln.setAttribute('y2',H);
    ln.setAttribute('stroke','var(--vscode-descriptionForeground)'); ln.setAttribute('stroke-dasharray','2,3'); ln.setAttribute('stroke-opacity','0.6');
    ln.innerHTML='<title>user prompt '+hhmm(pmTs)+(pmText ? ': '+escapeHtml(pmText.slice(0, 100)) : '')+'</title>'; svg.appendChild(ln); }
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
    row.innerHTML='<span class="n" title="'+escapeHtml(t.name)+'">'+t.name+'</span><div class="bar-wrap"><div class="bar" style="width:'+(t.count/max*100)+'%;background:'+colorForTool(t.name)+'"></div></div><span class="c">'+t.count+'</span>';
    el.appendChild(row); }
}
function renderFeed(st){
  const el=document.getElementById('feed'); el.innerHTML='';
  if(!st) return;
  const activity = st.activity || [];
  const prompts = (st.promptMarks || []).map(p => typeof p === 'object' && p !== null ? p : { ts: p, text: '' }).sort((a,b)=>a.ts-b.ts);
  const sortedActivity = activity.filter(a => a.ts > 0).sort((a,b)=>a.ts-b.ts);

  // Group tool calls by prompt turns
  const groups = [];
  const preCalls = [];

  for (const call of sortedActivity) {
    if (filterTool && call.tool !== filterTool) continue;
    
    let promptIdx = -1;
    for (let i = 0; i < prompts.length; i++) {
      if (prompts[i].ts <= call.ts) {
        promptIdx = i;
      } else {
        break;
      }
    }
    
    if (promptIdx === -1) {
      preCalls.push(call);
    } else {
      if (!groups[promptIdx]) {
        groups[promptIdx] = { prompt: prompts[promptIdx], calls: [] };
      }
      groups[promptIdx].calls.push(call);
    }
  }

  // Ensure all prompts are represented if no filter is active
  if (!filterTool) {
    for (let i = 0; i < prompts.length; i++) {
      if (!groups[i]) {
        groups[i] = { prompt: prompts[i], calls: [] };
      }
    }
  }

  // Render groups in descending order (newest prompt turn on top)
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    if (!g) continue;
    
    // Create turn block
    const turnDiv = document.createElement('div');
    turnDiv.className = 'turn';
    
    const pText = g.prompt.text || 'User Prompt';
    const pTime = hhmm(g.prompt.ts);
    
    let callsHtml = '';
    for (const a of g.calls) {
      callsHtml += '<div class="ev">' +
        '<span class="t">' + hhmm(a.ts) + '</span>' +
        '<span class="k" style="color:' + colorForTool(a.tool) + '">' + a.tool + '</span>' +
        '<span class="dur">' + dur(a.durationMs) + '</span>' +
        '<span class="d">' + escapeHtml(a.detail) + '</span>' +
      '</div>';
    }
    
    turnDiv.innerHTML = 
      '<div class="turn-header" title="' + escapeHtml(pText) + '">' +
        '<span class="turn-num">Turn #' + (i + 1) + '</span>' +
        '<span class="turn-time">' + pTime + '</span>' +
        '<span class="turn-text">' + escapeHtml(pText) + '</span>' +
      '</div>' +
      '<div class="turn-body">' + (callsHtml || '<div class="muted" style="font-style:italic;padding-left:12px;">Không gọi tool nào</div>') + '</div>';
      
    el.appendChild(turnDiv);
  }

  // Render pre-session calls if any
  if (preCalls.length > 0) {
    const preDiv = document.createElement('div');
    preDiv.className = 'turn';
    let callsHtml = '';
    for (const a of preCalls) {
      callsHtml += '<div class="ev">' +
        '<span class="t">' + hhmm(a.ts) + '</span>' +
        '<span class="k" style="color:' + colorForTool(a.tool) + '">' + a.tool + '</span>' +
        '<span class="dur">' + dur(a.durationMs) + '</span>' +
        '<span class="d">' + escapeHtml(a.detail) + '</span>' +
      '</div>';
    }
    preDiv.innerHTML = 
      '<div class="turn-header">' +
        '<span class="turn-num">Khởi tạo</span>' +
      '</div>' +
      '<div class="turn-body">' + callsHtml + '</div>';
    el.appendChild(preDiv);
  }
}
function renderAgents(st){
  const el=document.getElementById('agents'); el.innerHTML='';
  const models=st.models||[], agents=st.agents||[];
  // models
  if(models.length){
    const wrap=document.createElement('div'); wrap.style.marginBottom='8px';
    wrap.innerHTML='<div class="muted" style="margin-bottom:4px">models</div>'+
      models.map(m=>'<div style="display:flex;justify-content:space-between;gap:8px"><span><i style="display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;background:'+colorForTool(m.name)+'"></i>'+m.name+'</span><span class="muted">'+m.messages+' msg · '+fmt(m.output)+' out</span></div>').join('');
    el.appendChild(wrap);
  }
  // agents (subagents spawned via Task)
  const aw=document.createElement('div');
  if(agents.length){
    aw.innerHTML='<div class="muted" style="margin-bottom:4px">subagents ('+(st.sidechainMsgs||0)+' side-msgs)</div>'+
      agents.map(a=>'<div class="ev" style="padding:2px 0"><span class="k" style="width:auto">'+
        (a.running?'<span class="pill running" style="padding:0 6px"><span class="dot"></span></span> ':'')+a.type+
        '</span><span class="c" style="width:auto;margin:0 6px">×'+a.count+'</span><span class="d">'+escapeHtml(a.lastDesc||'')+'</span></div>').join('');
  } else {
    aw.innerHTML='<div class="muted" style="font-style:italic">Chưa spawn subagent nào (Task)</div>';
  }
  el.appendChild(aw);
}
function renderCost(st){
  const t=st.tokens, el=document.getElementById('cost');
  const totalInput = t.input + t.cacheWrite + t.cacheRead;
  const hitRate = totalInput > 0 ? (t.cacheRead / totalInput * 100) : 0;
  
  let cacheBarHtml = '';
  if (totalInput > 0) {
    cacheBarHtml = 
      '<div style="margin-top: 8px; margin-bottom: 4px;">' +
        '<div style="display:flex; justify-content:space-between; font-size:11px; margin-bottom:3px;">' +
          '<span class="muted">Cache Hit Rate</span>' +
          '<span style="font-weight: 600; color: var(--vscode-charts-green, #3fb950);">' + hitRate.toFixed(1) + '%</span>' +
        '</div>' +
        '<div style="height: 6px; border-radius: 3px; background: rgba(128,128,128,.2); display: flex; overflow: hidden;">' +
          '<div style="width: ' + hitRate + '%; background: var(--vscode-charts-green, #3fb950);"></div>' +
          '<div style="width: ' + (100 - hitRate) + '%; background: var(--vscode-charts-blue, #3794ff);"></div>' +
        '</div>' +
      '</div>';
  }

  el.innerHTML =
    '<div style="font-size:22px;font-weight:700">$'+st.costUsd.toFixed(3)+'</div>'+
    '<div class="muted" style="margin-bottom:6px">ước tính · '+(st.model||'?')+'</div>'+
    row('output', t.output) + row('input', t.input) + row('cache write', t.cacheWrite) + row('cache read', t.cacheRead) +
    cacheBarHtml;
  function row(l,v){ return '<div style="display:flex;justify-content:space-between"><span class="muted">'+l+'</span><span>'+fmt(v)+'</span></div>'; }
}
function renderStats(st){
  const el=document.getElementById('stats'), t=st.tokens;
  el.innerHTML =
    '<div style="font-size:22px;font-weight:700">'+st.files.length+' files</div>'+
    '<div class="muted" style="margin-bottom:6px">đã tương tác</div>'+
    row('Tool calls', st.tools.reduce((s,x)=>s+x.count,0)) +
    row('User prompts', (st.promptMarks||[]).length) +
    row('Output tokens', fmt(t.output));
  function row(l,v){ return '<div style="display:flex;justify-content:space-between"><span class="muted">'+l+'</span><span style="font-weight:600">'+v+'</span></div>'; }
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
  renderStats(st); renderCost(st); renderAgents(st); renderTimeline(st); renderAgentGraph(st); renderFilesList(st); renderTools(st.tools); renderFilter(st); renderFeed(st);
}

// ---- controls --------------------------------------------------------------
document.getElementById('session').addEventListener('change', e=> vscode.postMessage({type:'selectSession', file:e.target.value}));
document.getElementById('filter').addEventListener('change', e=>{ filterTool=e.target.value; if(last) renderFeed(last); });
document.getElementById('zoom-in').addEventListener('click', ()=>{ zoom=Math.min(20,zoom*1.5); if(last) renderTimeline(last); });
document.getElementById('zoom-out').addEventListener('click', ()=>{ zoom=Math.max(1,zoom/1.5); if(last) renderTimeline(last); });
document.getElementById('zoom-reset').addEventListener('click', ()=>{ zoom=1; if(last) renderTimeline(last); });
document.querySelector('.tl-wrap').addEventListener('wheel', e=>{ if(e.ctrlKey||e.metaKey){ e.preventDefault(); zoom=Math.min(20,Math.max(1, zoom*(e.deltaY<0?1.2:0.83))); if(last) renderTimeline(last); } }, {passive:false});

// ---- click-to-show help tooltips ------------------------------------------
const tip=document.getElementById('tip');
function hideTip(){ tip.style.display='none'; }
document.addEventListener('click', e=>{
  const h=e.target.closest?.('.help');
  if(h){ e.stopPropagation();
    if(tip.style.display==='block' && tip.dataset.for===h.dataset.tip){ hideTip(); return; }
    tip.textContent=h.dataset.tip||''; tip.dataset.for=h.dataset.tip||''; tip.style.display='block';
    const r=h.getBoundingClientRect(); let x=r.left, y=r.bottom+6;
    const tw=tip.offsetWidth, th=tip.offsetHeight;
    if(x+tw>window.innerWidth-8) x=window.innerWidth-tw-8;
    if(y+th>window.innerHeight-8) y=r.top-th-6;
    tip.style.left=Math.max(8,x)+'px'; tip.style.top=Math.max(8,y)+'px';
  } else { hideTip(); }
});
window.addEventListener('resize', hideTip);
window.addEventListener('scroll', hideTip, true);

window.addEventListener('message', e=>{ if(e.data?.type==='state'){ last=e.data.state; render(last); } });
window.addEventListener('resize', ()=>{ if(last){ renderTimeline(last); renderAgentGraph(last); } });
vscode.postMessage({type:'ready'});
</script>
</body>
</html>`;
}
