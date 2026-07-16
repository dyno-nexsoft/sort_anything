import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logInfo } from './utils';

/**
 * Claude Task Monitor
 * -------------------
 * Opens a webview (in the center editor area) that visualizes what Claude Code
 * is doing in the current workspace, by reading Claude Code's transcript JSONL
 * files under ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl.
 *
 * The webview shows:
 *   - a treemap of files Claude has touched (area = number of touches)
 *   - a live activity feed of tool calls
 *   - token usage totals
 *
 * Data source: the transcript file only (no hooks, no network). We tail the
 * newest .jsonl for the current workspace and re-parse (debounced) on change.
 */

// ---------------------------------------------------------------------------
// Transcript location + parsing
// ---------------------------------------------------------------------------

/** Claude Code encodes the cwd into a folder name by replacing every
 *  non-alphanumeric character with '-'.  e.g. e:\Projects\sort_anything
 *  becomes  e--Projects-sort-anything                                     */
function encodeProjectDir(cwd: string): string {
    return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function projectsDirForWorkspace(cwd: string): string {
    return path.join(os.homedir(), '.claude', 'projects', encodeProjectDir(cwd));
}

/** Return the most-recently-modified .jsonl in dir, or undefined. */
function findLatestTranscript(dir: string): string | undefined {
    let entries: string[];
    try {
        entries = fs.readdirSync(dir);
    } catch {
        return undefined;
    }
    let best: { file: string; mtime: number } | undefined;
    for (const name of entries) {
        if (!name.endsWith('.jsonl')) { continue; }
        const full = path.join(dir, name);
        try {
            const st = fs.statSync(full);
            if (!best || st.mtimeMs > best.mtime) {
                best = { file: full, mtime: st.mtimeMs };
            }
        } catch {
            /* ignore */
        }
    }
    return best?.file;
}

interface FileStat {
    path: string;      // absolute path as reported by Claude
    rel: string;       // path relative to cwd (for display / grouping)
    reads: number;
    writes: number;    // Edit + Write + MultiEdit
    other: number;     // Grep/Glob targeting the file, etc.
    total: number;
}

interface ActivityItem {
    ts: number;
    tool: string;
    detail: string;
}

interface MonitorState {
    title: string;
    sessionId: string;
    gitBranch: string;
    cwd: string;
    files: FileStat[];
    tools: { name: string; count: number }[];
    activity: ActivityItem[];
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
    updatedAt: number;
    error?: string;
}

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read']);
const FILE_TOOLS = new Set([...WRITE_TOOLS, ...READ_TOOLS, 'Grep', 'Glob']);

function toTime(v: unknown): number {
    if (typeof v === 'string') {
        const t = Date.parse(v);
        return isNaN(t) ? 0 : t;
    }
    return 0;
}

function shortName(name: string): string {
    return name.length > 60 ? '…' + name.slice(-57) : name;
}

function parseTranscript(file: string, cwd: string): MonitorState {
    const state: MonitorState = {
        title: '',
        sessionId: '',
        gitBranch: '',
        cwd,
        files: [],
        tools: [],
        activity: [],
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        updatedAt: Date.now(),
    };

    let raw: string;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
        state.error = `Cannot read transcript: ${(e as Error).message}`;
        return state;
    }

    const fileMap = new Map<string, FileStat>();
    const toolMap = new Map<string, number>();

    const touch = (absPath: unknown, kind: 'read' | 'write' | 'other') => {
        if (typeof absPath !== 'string' || !absPath) { return; }
        let fs0 = fileMap.get(absPath);
        if (!fs0) {
            let rel = absPath;
            try {
                const r = path.relative(cwd, absPath);
                if (r && !r.startsWith('..') && !path.isAbsolute(r)) { rel = r; }
            } catch { /* keep abs */ }
            fs0 = { path: absPath, rel: rel.replace(/\\/g, '/'), reads: 0, writes: 0, other: 0, total: 0 };
            fileMap.set(absPath, fs0);
        }
        if (kind === 'read') { fs0.reads++; }
        else if (kind === 'write') { fs0.writes++; }
        else { fs0.other++; }
        fs0.total++;
    };

    const lines = raw.split(/\r?\n/);
    for (const ln of lines) {
        const s = ln.trim();
        if (!s) { continue; }
        let o: any;
        try { o = JSON.parse(s); } catch { continue; }

        if (o.sessionId) { state.sessionId = o.sessionId; }
        if (o.gitBranch) { state.gitBranch = o.gitBranch; }
        if (o.cwd) { state.cwd = o.cwd; }
        if (o.type === 'ai-title' && o.aiTitle) { state.title = o.aiTitle; }

        if (o.type === 'assistant' && o.message) {
            const m = o.message;
            if (m.usage) {
                state.tokens.input += m.usage.input_tokens || 0;
                state.tokens.output += m.usage.output_tokens || 0;
                state.tokens.cacheRead += m.usage.cache_read_input_tokens || 0;
                state.tokens.cacheWrite += m.usage.cache_creation_input_tokens || 0;
            }
            if (Array.isArray(m.content)) {
                for (const c of m.content) {
                    if (c.type !== 'tool_use') { continue; }
                    const name: string = c.name || 'unknown';
                    toolMap.set(name, (toolMap.get(name) || 0) + 1);

                    const input = c.input || {};
                    let detail = '';
                    if (FILE_TOOLS.has(name) && input.file_path) {
                        const kind = WRITE_TOOLS.has(name) ? 'write' : READ_TOOLS.has(name) ? 'read' : 'other';
                        touch(input.file_path, kind);
                        detail = String(input.file_path);
                    } else if (name === 'Bash') {
                        detail = String(input.description || input.command || '');
                    } else if (name === 'Grep' || name === 'Glob') {
                        detail = String(input.pattern || '');
                        if (input.path) { touch(input.path, 'other'); }
                    } else if (input.file_path) {
                        detail = String(input.file_path);
                    } else {
                        detail = Object.keys(input).slice(0, 3).map(k => `${k}=${JSON.stringify(input[k])}`).join(' ').slice(0, 120);
                    }

                    state.activity.push({
                        ts: toTime(o.timestamp),
                        tool: name,
                        detail: shortName(detail),
                    });
                }
            }
        }
    }

    state.files = [...fileMap.values()].sort((a, b) => b.total - a.total);
    state.tools = [...toolMap.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);
    // newest activity first, keep it bounded
    state.activity.sort((a, b) => b.ts - a.ts);
    state.activity = state.activity.slice(0, 200);
    return state;
}

// ---------------------------------------------------------------------------
// Webview panel
// ---------------------------------------------------------------------------

export function openClaudeMonitor(context: vscode.ExtensionContext) {
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) {
        vscode.window.showErrorMessage('Claude Monitor: No workspace folder open.');
        return;
    }
    const cwd = wsFolder.uri.fsPath;
    const dir = projectsDirForWorkspace(cwd);

    const panel = vscode.window.createWebviewPanel(
        'dynoClaudeMonitor',
        'Claude Task Monitor',
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.webview.html = getHtml();

    let watcher: fs.FSWatcher | undefined;
    let currentFile: string | undefined;
    let debounce: NodeJS.Timeout | undefined;
    let disposed = false;

    const pushUpdate = () => {
        const latest = findLatestTranscript(dir);
        if (!latest) {
            panel.webview.postMessage({
                type: 'state',
                state: emptyState(cwd, `No Claude transcript found in\n${dir}`),
            });
            return;
        }
        // (re)attach watcher if the active session file changed
        if (latest !== currentFile) {
            currentFile = latest;
            watcher?.close();
            try {
                watcher = fs.watch(latest, () => scheduleUpdate());
            } catch { /* ignore */ }
        }
        const state = parseTranscript(latest, cwd);
        panel.webview.postMessage({ type: 'state', state });
    };

    const scheduleUpdate = () => {
        if (disposed) { return; }
        if (debounce) { clearTimeout(debounce); }
        debounce = setTimeout(pushUpdate, 250);
    };

    // Also watch the directory so we notice a brand-new session file appearing.
    let dirWatcher: fs.FSWatcher | undefined;
    try {
        dirWatcher = fs.watch(dir, () => scheduleUpdate());
    } catch { /* directory may not exist yet */ }

    panel.webview.onDidReceiveMessage((msg) => {
        if (msg?.type === 'ready' || msg?.type === 'refresh') { pushUpdate(); }
        if (msg?.type === 'open' && typeof msg.path === 'string') {
            vscode.workspace.openTextDocument(vscode.Uri.file(msg.path))
                .then(doc => vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside))
                .then(undefined, err => vscode.window.showErrorMessage(`Cannot open: ${err.message}`));
        }
    }, undefined, context.subscriptions);

    panel.onDidDispose(() => {
        disposed = true;
        if (debounce) { clearTimeout(debounce); }
        watcher?.close();
        dirWatcher?.close();
    }, undefined, context.subscriptions);

    logInfo(`Claude Monitor watching ${dir}`);
    pushUpdate();
}

function emptyState(cwd: string, error: string): MonitorState {
    return {
        title: '', sessionId: '', gitBranch: '', cwd,
        files: [], tools: [], activity: [],
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        updatedAt: Date.now(), error,
    };
}

// ---------------------------------------------------------------------------
// Webview HTML (self-contained: squarified treemap in plain SVG, no CDN)
// ---------------------------------------------------------------------------

function getHtml(): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: var(--vscode-font-family);
    font-size: 13px;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    margin: 0; padding: 12px;
  }
  header { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; }
  .muted { color: var(--vscode-descriptionForeground); font-size: 12px; }
  .badge {
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    border-radius: 10px; padding: 1px 8px; font-size: 11px;
  }
  .grid { display: grid; grid-template-columns: 1fr 320px; gap: 14px; align-items: start; }
  @media (max-width: 760px) { .grid { grid-template-columns: 1fr; } }
  .card {
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25));
    border-radius: 8px; padding: 10px;
  }
  .card h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .05em;
    color: var(--vscode-descriptionForeground); margin: 0 0 8px; }
  #treemap { width: 100%; height: 440px; display: block; }
  #timeline { width: 100%; height: 56px; display: block; }
  .tl-bar { cursor: pointer; }
  .axis { display: flex; justify-content: space-between; font-size: 11px;
    color: var(--vscode-descriptionForeground); margin-top: 4px; }
  .axis span:nth-child(2) { text-align: center; }
  .tm-cell rect { stroke: var(--vscode-editor-background); stroke-width: 1.5; cursor: pointer; }
  .tm-cell text { pointer-events: none; fill: #fff; font-size: 10px; }
  .tools { display: flex; flex-direction: column; gap: 4px; }
  .tool-row { display: flex; align-items: center; gap: 8px; }
  .tool-row .bar { height: 10px; border-radius: 3px; background: var(--vscode-charts-blue, #3794ff); }
  .tool-row .n { width: 78px; flex: none; }
  .tool-row .c { width: 32px; text-align: right; flex: none; color: var(--vscode-descriptionForeground); }
  .stats { display: flex; gap: 14px; flex-wrap: wrap; }
  .stat b { font-size: 18px; display: block; }
  .stat span { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .feed { max-height: 380px; overflow: auto; display: flex; flex-direction: column; gap: 2px; }
  .ev { display: flex; gap: 8px; padding: 3px 4px; border-radius: 4px; }
  .ev:hover { background: var(--vscode-list-hoverBackground); }
  .ev .t { color: var(--vscode-descriptionForeground); flex: none; width: 58px; font-variant-numeric: tabular-nums; }
  .ev .k { flex: none; width: 68px; font-weight: 600; }
  .ev .d { color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty { color: var(--vscode-descriptionForeground); white-space: pre-wrap; padding: 20px; text-align: center; }
  button.refresh {
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
    border: none; padding: 3px 10px; border-radius: 4px; cursor: pointer; font-size: 11px;
  }
  .legend { display: flex; gap: 10px; font-size: 11px; margin-top: 6px; color: var(--vscode-descriptionForeground); }
  .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
</style>
</head>
<body>
<header>
  <h1>🔍 Claude Task Monitor</h1>
  <span id="title" class="muted"></span>
  <span id="branch" class="badge" style="display:none"></span>
  <span style="flex:1"></span>
  <span id="updated" class="muted"></span>
  <button class="refresh" onclick="vscode.postMessage({type:'refresh'})">Refresh</button>
</header>

<div id="empty" class="empty" style="display:none"></div>

<div id="main">
  <div class="card" style="margin-bottom:14px">
    <div class="stats" id="stats"></div>
  </div>
  <div class="card" style="margin-bottom:14px">
    <h2>Timeline (mỗi vạch = 1 tool call, màu theo tool)</h2>
    <svg id="timeline" preserveAspectRatio="none"></svg>
    <div class="axis"><span id="tl-start"></span><span id="tl-dur"></span><span id="tl-end"></span></div>
    <div class="legend" id="tl-legend"></div>
  </div>
  <div class="grid">
    <div class="card">
      <h2>Files touched (area = số lần đụng vào · màu theo thư mục)</h2>
      <svg id="treemap" preserveAspectRatio="none"></svg>
      <div class="legend" id="tm-legend"></div>
    </div>
    <div style="display:flex; flex-direction:column; gap:14px;">
      <div class="card">
        <h2>Tool usage</h2>
        <div class="tools" id="tools"></div>
      </div>
      <div class="card">
        <h2>Activity (mới nhất)</h2>
        <div class="feed" id="feed"></div>
      </div>
    </div>
  </div>
</div>

<script>
const vscode = acquireVsCodeApi();

function fmt(n){ return n>=1000 ? (n/1000).toFixed(n>=10000?0:1)+'k' : String(n); }
function hhmm(ts){ if(!ts) return ''; const d=new Date(ts); return d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'}); }

// ---- squarified treemap ----------------------------------------------------
function squarify(items, x, y, w, h){
  // items: [{value, ...}]  -> assigns .rect {x,y,w,h}
  const total = items.reduce((s,it)=>s+it.value,0) || 1;
  const scaled = items.map(it => ({ ref: it, area: it.value/total * (w*h) }));
  let rx=x, ry=y, rw=w, rh=h;
  let row=[];
  const worst = (row, len) => {
    const s = row.reduce((a,b)=>a+b.area,0);
    const max = Math.max(...row.map(r=>r.area));
    const min = Math.min(...row.map(r=>r.area));
    const len2 = len*len, s2 = s*s;
    return Math.max((len2*max)/s2, s2/(len2*min));
  };
  const layoutRow = (row, horizontal) => {
    const s = row.reduce((a,b)=>a+b.area,0);
    if(horizontal){
      const rowH = s/rw; let cx=rx;
      for(const r of row){ const cw=r.area/rowH; r.ref.rect={x:cx,y:ry,w:cw,h:rowH}; cx+=cw; }
      ry+=rowH; rh-=rowH;
    } else {
      const rowW = s/rh; let cy=ry;
      for(const r of row){ const ch=r.area/rowW; r.ref.rect={x:rx,y:cy,w:rowW,h:ch}; cy+=ch; }
      rx+=rowW; rw-=rowW;
    }
  };
  let i=0;
  while(i<scaled.length){
    const horizontal = rw >= rh;
    const len = horizontal ? rw : rh;
    const next = scaled[i];
    if(row.length===0){ row.push(next); i++; continue; }
    const cur = worst(row, len);
    const wNext = worst([...row, next], len);
    if(wNext <= cur){ row.push(next); i++; }
    else { layoutRow(row, horizontal); row=[]; }
  }
  if(row.length) layoutRow(row, rw >= rh);
}

const palette = ['#3794ff','#3fb950','#d29922','#a371f7','#f78166','#56d4bb','#db61a2','#e3b341'];
function hashStr(s){ let h=0; for(let i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))>>>0; return h; }
function topDir(rel){ return rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : '(root)'; }
function colorForTop(top){ return palette[hashStr(top) % palette.length]; }
function colorForDir(rel){ return colorForTop(topDir(rel)); }
// consistent color per tool for the timeline
function colorForTool(name){ return palette[hashStr(name) % palette.length]; }

function renderTreemap(files){
  const svg = document.getElementById('treemap');
  svg.innerHTML='';
  const W = svg.clientWidth || 600, H = 440;
  svg.setAttribute('viewBox', '0 0 '+W+' '+H);
  const legend = document.getElementById('tm-legend');
  if(!files.length){ legend.innerHTML=''; return; }
  // dynamic legend: top-level directories present, by descending touch count
  const dirTotals={};
  for(const f of files){ const top=topDir(f.rel); dirTotals[top]=(dirTotals[top]||0)+f.total; }
  legend.innerHTML = Object.entries(dirTotals).sort((a,b)=>b[1]-a[1]).slice(0,8)
    .map(([d,c])=>'<span><i style="background:'+colorForTop(d)+'"></i>'+d+' ('+c+')</span>').join('')
    + '<span>· click ô để mở file</span>';
  const items = files.map(f => ({ value: f.total, f }));
  squarify(items, 0, 0, W, H);
  const ns='http://www.w3.org/2000/svg';
  for(const it of items){
    const r=it.rect; if(!r || r.w<1 || r.h<1) continue;
    const g=document.createElementNS(ns,'g'); g.setAttribute('class','tm-cell');
    const rect=document.createElementNS(ns,'rect');
    rect.setAttribute('x',r.x); rect.setAttribute('y',r.y);
    rect.setAttribute('width',Math.max(0,r.w)); rect.setAttribute('height',Math.max(0,r.h));
    rect.setAttribute('fill', colorForDir(it.f.rel));
    rect.setAttribute('fill-opacity', '0.85');
    const name = it.f.rel.split('/').pop();
    rect.innerHTML = '<title>'+it.f.rel+'\\n'+it.f.total+' touches (read '+it.f.reads+', write '+it.f.writes+', other '+it.f.other+')</title>';
    rect.addEventListener('click', ()=> vscode.postMessage({type:'open', path: it.f.path}));
    g.appendChild(rect);
    if(r.w>44 && r.h>16){
      const t=document.createElementNS(ns,'text');
      t.setAttribute('x', r.x+4); t.setAttribute('y', r.y+13);
      t.textContent = name.length*6 > r.w-8 ? name.slice(0, Math.max(1,Math.floor((r.w-8)/6)))+'…' : name;
      g.appendChild(t);
    }
    svg.appendChild(g);
  }
}

function renderTimeline(activity){
  const svg = document.getElementById('timeline');
  svg.innerHTML='';
  const legend = document.getElementById('tl-legend');
  const evs = activity.filter(a => a.ts > 0).slice().sort((a,b)=>a.ts-b.ts);
  const W = svg.clientWidth || 600, H = 56;
  svg.setAttribute('viewBox', '0 0 '+W+' '+H);
  document.getElementById('tl-start').textContent='';
  document.getElementById('tl-end').textContent='';
  document.getElementById('tl-dur').textContent='';
  legend.innerHTML='';
  if(!evs.length){ return; }
  const min = evs[0].ts, max = evs[evs.length-1].ts;
  const span = Math.max(1, max-min);
  const ns='http://www.w3.org/2000/svg';
  const bw = 3;
  for(const a of evs){
    const x = min===max ? W/2 : ((a.ts-min)/span)*(W-bw);
    const rect=document.createElementNS(ns,'rect');
    rect.setAttribute('class','tl-bar');
    rect.setAttribute('x', x); rect.setAttribute('y', 2);
    rect.setAttribute('width', bw); rect.setAttribute('height', H-4);
    rect.setAttribute('fill', colorForTool(a.tool));
    rect.setAttribute('rx','1');
    rect.innerHTML = '<title>'+hhmm(a.ts)+'  '+a.tool+'\\n'+escapeHtml(a.detail)+'</title>';
    svg.appendChild(rect);
  }
  document.getElementById('tl-start').textContent = hhmm(min);
  document.getElementById('tl-end').textContent = hhmm(max);
  const mins = Math.round((max-min)/60000);
  document.getElementById('tl-dur').textContent = mins>0 ? (mins+' phút · '+evs.length+' calls') : (evs.length+' calls');
  // legend: tools present, by frequency
  const cnt={}; for(const a of evs) cnt[a.tool]=(cnt[a.tool]||0)+1;
  legend.innerHTML = Object.entries(cnt).sort((a,b)=>b[1]-a[1])
    .map(([t,c])=>'<span><i style="background:'+colorForTool(t)+'"></i>'+t+' ('+c+')</span>').join('');
}

function renderTools(tools){
  const el=document.getElementById('tools'); el.innerHTML='';
  const max = Math.max(1, ...tools.map(t=>t.count));
  for(const t of tools){
    const row=document.createElement('div'); row.className='tool-row';
    row.innerHTML = '<span class="n">'+t.name+'</span>'+
      '<div class="bar" style="width:'+(t.count/max*160)+'px"></div>'+
      '<span class="c">'+t.count+'</span>';
    el.appendChild(row);
  }
}

function renderFeed(activity){
  const el=document.getElementById('feed'); el.innerHTML='';
  for(const a of activity){
    const ev=document.createElement('div'); ev.className='ev';
    ev.innerHTML = '<span class="t">'+hhmm(a.ts)+'</span>'+
      '<span class="k">'+a.tool+'</span>'+
      '<span class="d">'+escapeHtml(a.detail)+'</span>';
    el.appendChild(ev);
  }
}
function escapeHtml(s){ return String(s).replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

function renderStats(st){
  const el=document.getElementById('stats');
  const tk=st.tokens;
  el.innerHTML =
    stat(st.files.length, 'files touched') +
    stat(st.tools.reduce((s,t)=>s+t.count,0), 'tool calls') +
    stat(fmt(tk.output), 'output tokens') +
    stat(fmt(tk.input+tk.cacheRead+tk.cacheWrite), 'input tokens') +
    stat(fmt(tk.cacheRead), 'cache read');
}
function stat(v,l){ return '<div class="stat"><b>'+v+'</b><span>'+l+'</span></div>'; }

function render(st){
  const empty=document.getElementById('empty'), main=document.getElementById('main');
  if(st.error){ empty.style.display='block'; empty.textContent=st.error; main.style.display='none'; return; }
  empty.style.display='none'; main.style.display='block';
  document.getElementById('title').textContent = st.title || '';
  const b=document.getElementById('branch');
  if(st.gitBranch){ b.style.display='inline-block'; b.textContent='⑂ '+st.gitBranch; } else { b.style.display='none'; }
  document.getElementById('updated').textContent = 'cập nhật ' + hhmm(st.updatedAt);
  renderStats(st);
  renderTimeline(st.activity);
  renderTreemap(st.files);
  renderTools(st.tools);
  renderFeed(st.activity);
}

let last=null;
window.addEventListener('message', e => { if(e.data?.type==='state'){ last=e.data.state; render(last); } });
window.addEventListener('resize', ()=> { if(last){ renderTimeline(last.activity); renderTreemap(last.files); } });
vscode.postMessage({type:'ready'});
</script>
</body>
</html>`;
}
