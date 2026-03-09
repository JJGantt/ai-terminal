import { app, BrowserWindow, ipcMain, Menu, WebContents } from 'electron';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import http from 'node:http';
import { execSync, execFile } from 'node:child_process';
import started from 'electron-squirrel-startup';
import pty from 'node-pty';
import { WebSocketServer, WebSocket } from 'ws';
import { initVoice, transcribeAudioFile } from './voice';
import { loadConfig } from './config';

if (started) app.quit();

fs.writeFileSync('/tmp/ai-terminal.log', '');
const log = (...args: unknown[]) => {
  const line = `[main] ${args.join(' ')}\n`;
  process.stdout.write(line);
  fs.appendFileSync('/tmp/ai-terminal.log', line);
};
log('main process starting');

const ptySessions = new Map<string, ReturnType<typeof pty.spawn>>();
let activeTabId: string | null = null;
let mainWindow: BrowserWindow | null = null;

// Remote client state (phone companion app)
const WS_PORT = 27183;
const MAX_SCROLLBACK = 100 * 1024; // 100KB per session
const scrollback = new Map<string, string>(); // tabId → raw PTY buffer
const wsClients = new Map<string, Set<WebSocket>>(); // tabId → subscribers
const tabNames = new Map<string, string>(); // tabId → display name
const tabWorking = new Map<string, boolean>(); // tabId → working state

function getTabList() {
  return [...ptySessions.keys()].map(id => ({
    id,
    name: tabNames.get(id) || 'New Session',
    working: tabWorking.get(id) || false,
  }));
}

function broadcastSessions() {
  const msg = JSON.stringify({ type: 'sessions', tabs: getTabList() });
  wsServer.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

function appendScrollback(tabId: string, data: string) {
  const current = scrollback.get(tabId) || '';
  const next = current + data;
  scrollback.set(tabId, next.length > MAX_SCROLLBACK ? next.slice(-MAX_SCROLLBACK) : next);
}

function broadcastData(tabId: string, data: string) {
  const subs = wsClients.get(tabId);
  if (!subs?.size) return;
  const msg = JSON.stringify({ type: 'data', tabId, data });
  for (const ws of subs) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

const wsServer = new WebSocketServer({ port: WS_PORT, host: '0.0.0.0' });
wsServer.on('listening', () => log(`WS server on :${WS_PORT}`));
wsServer.on('connection', (ws: WebSocket) => {
  let currentTab: string | null = null;
  let clientCols = 0;
  let clientRows = 0;
  ws.send(JSON.stringify({ type: 'sessions', tabs: getTabList() }));

  ws.on('message', (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      switch (msg.type) {
        case 'subscribe': {
          if (currentTab) wsClients.get(currentTab)?.delete(ws);
          currentTab = msg.tabId;
          if (!wsClients.has(currentTab)) wsClients.set(currentTab, new Set());
          wsClients.get(currentTab)!.add(ws);
          const buf = scrollback.get(currentTab);
          if (buf) ws.send(JSON.stringify({ type: 'scrollback', tabId: currentTab, data: buf }));
          // Auto-resize the subscribed tab to this client's terminal size
          if (clientCols > 0 && clientRows > 0) {
            ptySessions.get(currentTab)?.resize(clientCols, clientRows);
          }
          break;
        }
        case 'input':
          ptySessions.get(msg.tabId)?.write(msg.data);
          break;
        case 'resize':
          clientCols = msg.cols;
          clientRows = msg.rows;
          ptySessions.get(msg.tabId)?.resize(msg.cols, msg.rows);
          break;
        case 'list':
          ws.send(JSON.stringify({ type: 'sessions', tabs: getTabList() }));
          break;
        case 'voice_audio': {
          const { tabId, data, durationS } = msg;
          const audioPath = '/tmp/ai-terminal-phone-voice.wav';
          fs.writeFileSync(audioPath, Buffer.from(data, 'base64'));
          log(`phone voice: received ${durationS?.toFixed(1)}s audio for tab ${tabId}`);
          transcribeAudioFile(audioPath, durationS || 0, log, (text) => {
            if (!text) { log('phone voice: empty transcription'); return; }
            log('phone voice: transcribed:', text.slice(0, 100));
            ptySessions.get(tabId)?.write(text + '\r');
          });
          break;
        }
        case 'new_tab': {
          const tabId = `phone-${Date.now()}`;
          spawnPty(tabId, undefined, null);
          ws.send(JSON.stringify({ type: 'tab_created', tabId }));
          break;
        }
        case 'resume_tab': {
          const tabId = `phone-${Date.now()}`;
          spawnPty(tabId, msg.sessionId, null);
          ws.send(JSON.stringify({ type: 'tab_created', tabId }));
          break;
        }
        case 'kill_tab': {
          const p = ptySessions.get(msg.tabId);
          if (p) {
            log('ws: killing tab:', msg.tabId);
            p.kill();
            ptySessions.delete(msg.tabId);
            tabNames.delete(msg.tabId);
            tabWorking.delete(msg.tabId);
            scrollback.delete(msg.tabId);
            wsClients.delete(msg.tabId);
            broadcastSessions();
          }
          break;
        }
        case 'history_request': {
          const sessions = getHistorySessions(Date.now() - 7 * 86400000)
            .sort((a, b) => b.mtime - a.mtime)
            .slice(0, 50)
            .map(s => ({ id: s.id, title: nameCache[s.id] || s.title, timestamp: s.timestamp, source: s.source }));
          ws.send(JSON.stringify({ type: 'history', sessions }));
          break;
        }
        case 'regenerate_name': {
          const { sessionId } = msg;
          if (!sessionId) break;
          const jsonlPath = findSessionJSONL(sessionId);
          if (!jsonlPath) { log('regenerate: no JSONL found for', sessionId); break; }
          const pairs = readConversationPairs(jsonlPath, 5);
          if (!pairs.length) break;
          const liveTabId = [...tabSessionIds.entries()].find(([, sid]) => sid === sessionId)?.[0];
          generateName(sessionId, liveTabId || `regen-${sessionId}`, pairs);
          break;
        }
      }
    } catch (e) {
      log('ws error:', (e as Error).message);
    }
  });

  ws.on('close', () => {
    if (currentTab) wsClients.get(currentTab)?.delete(ws);
  });
});

ipcMain.on('tab:active', (_e, id: string) => {
  activeTabId = id;
  fs.writeFileSync('/tmp/ai-terminal-active-tab', id);
  log('active tab:', id);
});

// ── Pi WebSocket client ──────────────────────────────────────────────────────
const PI_HOSTS = ['raspberrypi.local', '100.104.197.58'];
let piWs: WebSocket | null = null;
let piConnected = false;
let piHostIndex = 0;

function connectToPi() {
  const host = PI_HOSTS[piHostIndex];
  const url = `ws://${host}:27183`;
  log(`pi: connecting to ${url}`);

  const ws = new WebSocket(url);
  ws.on('open', () => {
    log('pi: connected');
    piWs = ws;
    piConnected = true;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pi:connected', true);
    }
  });

  ws.on('message', (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      switch (msg.type) {
        case 'sessions': {
          const tabs = (msg.tabs || []).map((t: { id: string; name: string; working: boolean }) => ({
            id: t.id, name: t.name, working: t.working,
          }));
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('pi:tabs', tabs);
          }
          break;
        }
        case 'scrollback':
        case 'data': {
          if (mainWindow && !mainWindow.isDestroyed() && msg.tabId) {
            mainWindow.webContents.send(`pty:data:${msg.tabId}`, msg.data);
          }
          break;
        }
        case 'tab_created': {
          if (mainWindow && !mainWindow.isDestroyed() && msg.tabId) {
            mainWindow.webContents.send('pi:tab-created', msg.tabId);
          }
          break;
        }
      }
    } catch (e) {
      log('pi: message error:', (e as Error).message);
    }
  });

  ws.on('close', () => {
    log('pi: disconnected');
    piWs = null;
    piConnected = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pi:connected', false);
      mainWindow.webContents.send('pi:tabs', []);
    }
    setTimeout(() => {
      piHostIndex = (piHostIndex + 1) % PI_HOSTS.length;
      connectToPi();
    }, 3000);
  });

  ws.on('error', (err) => {
    log('pi: error:', err.message);
  });
}

function piSend(msg: Record<string, unknown>) {
  if (piWs?.readyState === WebSocket.OPEN) {
    piWs.send(JSON.stringify(msg));
  }
}

ipcMain.on('pi:new-tab', () => { piSend({ type: 'new_tab' }); });
ipcMain.on('pi:resume-tab', (_e, sessionId: string) => { piSend({ type: 'resume_tab', sessionId }); });

// IPC server for tab rename and active-tab queries
const IPC_PORT = 27182;
const ipcServer = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/rename') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { tabId, title } = JSON.parse(body);
        log('rename tab:', tabId, '→', title);
        tabNames.set(tabId, title);
        broadcastSessions();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('tab:rename', tabId, title);
        }
        res.writeHead(200); res.end('{"ok":true}');
      } catch {
        res.writeHead(400); res.end('{"error":"bad request"}');
      }
    });
  } else if (req.method === 'POST' && req.url === '/session-id') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { tabId, sessionId } = JSON.parse(body);
        log('session-id:', tabId, '→', sessionId);
        tabSessionIds.set(tabId, sessionId);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('tab:session-mapped', tabId, sessionId);
        }

        // If we have a cached name, apply it immediately
        if (nameCache[sessionId]) {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('tab:rename', tabId, nameCache[sessionId]);
          }
        } else {
          // Trigger naming now that we know the session ID
          const jsonlPath = findSessionJSONL(sessionId);
          if (jsonlPath) {
            const pairs = readConversationPairs(jsonlPath, 1);
            if (pairs.length) generateName(sessionId, tabId, pairs);
          }
        }
        res.writeHead(200); res.end('{"ok":true}');
      } catch {
        res.writeHead(400); res.end('{"error":"bad request"}');
      }
    });
  } else if (req.method === 'GET' && req.url === '/active-tab') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tabId: activeTabId }));
  } else {
    res.writeHead(404); res.end();
  }
}).on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    log(`port ${IPC_PORT} in use — killing old process and retrying`);
    try { execSync(`lsof -ti :${IPC_PORT} | xargs kill -9`); } catch (_e) { /* ignore */ }
    setTimeout(() => {
      ipcServer.listen(IPC_PORT, '127.0.0.1', () => log(`IPC server on :${IPC_PORT} (retry)`));
    }, 500);
  } else {
    log('IPC server error:', err.message);
  }
}).listen(IPC_PORT, '127.0.0.1', () => log(`IPC server on :${IPC_PORT}`));

// Session listing — scan history + JSONL files
const config = loadConfig();
const PROJECTS_ROOT = path.join(os.homedir(), '.claude/projects');
const HISTORY_DIR = config.historyDir;
log('history dir:', HISTORY_DIR);

// Tab name cache — lives in history dir so it syncs across devices
const NAME_CACHE_PATH = path.join(HISTORY_DIR, 'tab-names.json');
let nameCache: Record<string, string> = {};
try {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  nameCache = JSON.parse(fs.readFileSync(NAME_CACHE_PATH, 'utf-8'));
} catch { /* first run or corrupt — start fresh */ }

function saveNameCache() {
  fs.writeFileSync(NAME_CACHE_PATH, JSON.stringify(nameCache, null, 2));
}

// Hidden sessions — lives in history dir so it syncs across devices
const HIDDEN_SESSIONS_PATH = path.join(HISTORY_DIR, 'hidden-sessions.json');
let hiddenSessions: Set<string> = new Set();
try {
  const raw = JSON.parse(fs.readFileSync(HIDDEN_SESSIONS_PATH, 'utf-8'));
  hiddenSessions = new Set(raw.ids || []);
} catch { /* first run */ }

function saveHiddenSessions() {
  fs.writeFileSync(HIDDEN_SESSIONS_PATH, JSON.stringify({ ids: [...hiddenSessions] }, null, 2));
}

interface SessionInfo {
  id: string;
  title: string;
  timestamp: string;
  mtime: number;
  project: string;
  source?: string;
}

interface SessionMeta {
  title: string;
  timestamp: string;
  isNamingSession: boolean;
}

function getSessionMeta(filePath: string): SessionMeta {
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(16384);
  const bytesRead = fs.readSync(fd, buf, 0, 16384, 0);
  fs.closeSync(fd);
  const chunk = buf.toString('utf-8', 0, bytesRead);
  const lines = chunk.split('\n');

  let title = '';
  let timestamp = '';
  let isNamingSession = false;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (!timestamp && msg.timestamp) timestamp = msg.timestamp;
      if (!title && msg.type === 'user' && msg.message?.role === 'user') {
        const content = msg.message.content;
        let text = '';
        if (typeof content === 'string') {
          text = content;
        } else if (Array.isArray(content)) {
          const textBlock = content.find((b: { type: string }) => b.type === 'text');
          if (textBlock) text = textBlock.text;
        }
        if (text.includes('Give a 2-3 word tab title')) {
          isNamingSession = true;
          break;
        }
        title = text.slice(0, 100);
      }
      if (title && timestamp) break;
    } catch { /* skip malformed lines */ }
  }

  return { title: title || 'Untitled', timestamp, isNamingSession };
}

function getHistorySessions(since?: number): SessionInfo[] {
  const sessions = new Map<string, SessionInfo>();
  try {
    let files = fs.readdirSync(HISTORY_DIR)
      .filter(f => f.endsWith('.json') && /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort();

    // If a since timestamp is given, only read files from that date forward
    if (since) {
      const sinceDate = new Date(since).toISOString().slice(0, 10);
      files = files.filter(f => f.replace('.json', '') >= sinceDate);
    } else {
      files = files.slice(-14); // default: last 14 days
    }

    for (const file of files) {
      const entries = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, file), 'utf-8'));
      for (const entry of entries) {
        if (!entry.session_id || !entry.source) continue;
        if (entry.source === 'system' || entry.source === 'system-error') continue;
        if (hiddenSessions.has(entry.session_id)) continue;
        if (!sessions.has(entry.session_id)) {
          sessions.set(entry.session_id, {
            id: entry.session_id,
            title: (entry.user || '').slice(0, 100) || 'Untitled',
            timestamp: entry.timestamp,
            mtime: new Date(entry.timestamp).getTime(),
            project: entry.source,
            source: entry.source,
          });
        } else {
          const existing = sessions.get(entry.session_id)!;
          const entryTime = new Date(entry.timestamp).getTime();
          if (entryTime > existing.mtime) existing.mtime = entryTime;
        }
      }
    }
  } catch (err) {
    log('getHistorySessions error:', (err as Error).message);
  }
  return [...sessions.values()].filter(s => s.title !== 'Untitled');
}

// Get available date groups for progressive loading
function getHistoryDateGroups(): string[] {
  try {
    return fs.readdirSync(HISTORY_DIR)
      .filter(f => f.endsWith('.json') && /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map(f => f.replace('.json', ''))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

ipcMain.handle('sessions:list', (_e, opts?: { since?: number; date?: string }) => {
  try {
    const sessions: SessionInfo[] = [];
    const seenIds = new Set<string>();

    // Primary: history sessions
    if (opts?.date) {
      // Load a specific date
      const since = new Date(opts.date).getTime();
      const dayEnd = since + 86400000;
      for (const s of getHistorySessions(since)) {
        if (s.mtime < dayEnd) {
          if (nameCache[s.id]) s.title = nameCache[s.id];
          sessions.push(s);
          seenIds.add(s.id);
        }
      }
    } else {
      // Default: last 24h from history + JSONL fallback
      const since = opts?.since || (Date.now() - 86400000);
      for (const s of getHistorySessions(since)) {
        if (nameCache[s.id]) s.title = nameCache[s.id];
        sessions.push(s);
        seenIds.add(s.id);
      }
    }

    // Fallback: JSONL sessions not in history
    const projectDirs = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const dir of projectDirs) {
      const projectPath = path.join(PROJECTS_ROOT, dir.name);
      const files = fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));

      for (const file of files) {
        const filePath = path.join(projectPath, file);
        const stat = fs.statSync(filePath);
        if (stat.size < 500) continue;
        const id = file.replace('.jsonl', '');
        if (seenIds.has(id)) continue; // already in history
        if (hiddenSessions.has(id)) continue;
        const { title, timestamp, isNamingSession } = getSessionMeta(filePath);
        if (isNamingSession) continue;
        if (title === 'Untitled') continue;
        const displayTitle = nameCache[id] || title;
        sessions.push({ id, title: displayTitle, timestamp, mtime: stat.mtimeMs, project: dir.name });
        seenIds.add(id);
      }
    }

    sessions.sort((a, b) => b.mtime - a.mtime);
    return sessions;
  } catch (err) {
    log('sessions:list error:', (err as Error).message);
    return [];
  }
});

// Date groups for progressive loading
ipcMain.handle('sessions:dates', () => {
  return getHistoryDateGroups();
});

ipcMain.handle('sessions:hide', (_e, sessionId: string) => {
  hiddenSessions.add(sessionId);
  saveHiddenSessions();
  log('session hidden:', sessionId);
  return true;
});

ipcMain.on('session:context-menu', (_e, sessionId: string) => {
  const menu = Menu.buildFromTemplate([
    {
      label: 'Hide Session',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('session:confirm-hide', sessionId);
        }
      },
    },
  ]);
  menu.popup();
});

// Convert project key back to a filesystem path.
// Keys use - as separator: -Users-jaredgantt-Life-Job → /Users/jaredgantt/Life/Job
// Ambiguity (hyphens in dir names) resolved by greedy filesystem matching.
function projectKeyToPath(key: string): string | null {
  const segments = key.replace(/^-/, '').split('-');
  let current = '/';
  let i = 0;
  while (i < segments.length) {
    let matched = false;
    // Try longest possible chunk first (handles hyphens in dir names)
    for (let end = segments.length; end > i; end--) {
      const candidate = segments.slice(i, end).join('-');
      const tryPath = path.join(current, candidate);
      try {
        if (fs.statSync(tryPath).isDirectory()) {
          current = tryPath;
          i = end;
          matched = true;
          break;
        }
      } catch { /* doesn't exist */ }
    }
    if (!matched) return null;
  }
  return current;
}

function resolveSessionCwd(sessionId: string): string {
  const defaultCwd = path.join(os.homedir(), 'workspace');
  try {
    const projectDirs = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true })
      .filter(d => d.isDirectory());
    for (const dir of projectDirs) {
      if (fs.existsSync(path.join(PROJECTS_ROOT, dir.name, `${sessionId}.jsonl`))) {
        const resolved = projectKeyToPath(dir.name);
        if (resolved) return resolved;
      }
    }
  } catch { /* fallback */ }
  return defaultCwd;
}

function spawnPty(id: string, resumeSessionId: string | undefined, sender: WebContents | null) {
  log('creating pty:', id, resumeSessionId ? `(resuming ${resumeSessionId})` : '');

  const env = getCleanEnv();
  const cwd = resumeSessionId ? resolveSessionCwd(resumeSessionId) : path.join(os.homedir(), 'workspace');
  log('pty cwd:', cwd);
  const args = ['--dangerously-skip-permissions'];
  if (resumeSessionId) args.push('--resume', resumeSessionId);

  const ptyProcess = pty.spawn('claude', args, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd,
    env,
  });

  ptySessions.set(id, ptyProcess);
  tabNames.set(id, 'New Session');
  tabWorking.set(id, false);
  broadcastSessions();

  let hasBeenIdle = false;
  let wasWorking = false;
  ptyProcess.onData((data) => {
    appendScrollback(id, data);
    broadcastData(id, data);
    const titleMatch = data.match(/\x1b\]0;(.*?)\x07/);
    if (titleMatch) {
      const title = titleMatch[1];
      if (title.startsWith('\u2733')) {
        if (wasWorking) {
          if (sender && !sender.isDestroyed()) sender.send('tab:bell', id);
          wasWorking = false;
          tabWorking.set(id, false);
          broadcastSessions();
        }
        hasBeenIdle = true;
      } else if (hasBeenIdle) {
        if (!wasWorking) {
          if (sender && !sender.isDestroyed()) sender.send('tab:working', id);
          wasWorking = true;
          tabWorking.set(id, true);
          broadcastSessions();
        }
      }
    }
    if (sender && !sender.isDestroyed()) sender.send(`pty:data:${id}`, data);
  });
  ptyProcess.onExit(({ exitCode, signal }) => {
    log(`pty exited: ${id} exitCode=${exitCode} signal=${signal}`);
    ptySessions.delete(id);
    tabNames.delete(id);
    tabWorking.delete(id);
    scrollback.delete(id);
    wsClients.delete(id);
    broadcastSessions();
    if (sender && !sender.isDestroyed()) sender.send(`pty:exit:${id}`);
  });

  if (resumeSessionId) {
    tabSessionIds.set(id, resumeSessionId);
    if (nameCache[resumeSessionId]) {
      tabNames.set(id, nameCache[resumeSessionId]);
      broadcastSessions();
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tab:session-mapped', id, resumeSessionId);
      if (nameCache[resumeSessionId]) {
        mainWindow.webContents.send('tab:rename', id, nameCache[resumeSessionId]);
      }
    }
  }
}

ipcMain.handle('pty:create', (event, id: string, resumeSessionId?: string) => {
  if (id.startsWith('pi-')) {
    // Pi tab — subscribe via WS client instead of spawning local PTY
    piSend({ type: 'subscribe', tabId: id });
    return id;
  }
  spawnPty(id, resumeSessionId, event.sender);
  return id;
});

// Tab naming — discover Claude session ID, then ask Haiku for a title
const tabSessionIds = new Map<string, string>(); // tab id → claude session UUID

function getCleanEnv() {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_SESSION_ID;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  return env;
}

function findSessionJSONL(sessionId: string): string | null {
  try {
    const projectDirs = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true })
      .filter(d => d.isDirectory());
    for (const dir of projectDirs) {
      const filePath = path.join(PROJECTS_ROOT, dir.name, `${sessionId}.jsonl`);
      if (fs.existsSync(filePath)) return filePath;
    }
  } catch { /* ignore */ }
  return null;
}

function readConversationPairs(filePath: string, maxPairs: number): { user: string; assistant: string }[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const pairs: { user: string; assistant: string }[] = [];
  let currentUser = '';

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.type === 'user' && msg.message?.role === 'user') {
        const c = msg.message.content;
        let text = '';
        if (typeof c === 'string') text = c;
        else if (Array.isArray(c)) {
          text = c.filter((b: { type: string }) => b.type === 'text')
            .map((b: { text: string }) => b.text).join(' ');
        }
        if (text.trim()) currentUser = text.trim().slice(0, 200);
      } else if (msg.type === 'assistant' && msg.message?.role === 'assistant' && currentUser) {
        const c = msg.message.content;
        let text = '';
        if (typeof c === 'string') text = c;
        else if (Array.isArray(c)) {
          text = c.filter((b: { type: string }) => b.type === 'text')
            .map((b: { text: string }) => b.text).join(' ');
        }
        if (text.trim()) {
          pairs.push({ user: currentUser, assistant: text.trim().slice(0, 200) });
          currentUser = '';
        }
      }
    } catch { /* skip */ }
  }

  // Return last N pairs
  return pairs.slice(-maxPairs);
}

function generateName(sessionId: string, tabId: string, pairs: { user: string; assistant: string }[]) {
  if (!pairs.length) return;

  let prompt: string;
  if (pairs.length === 1) {
    prompt = `Give a 2-3 word tab title for this user message. Output ONLY the title, nothing else. No quotes. No punctuation.\n\nUser message: ${pairs[0].user}`;
  } else {
    const conversation = pairs.map(p => `User: ${p.user}\nAssistant: ${p.assistant}`).join('\n\n');
    prompt = `Give a 2-3 word tab title for this conversation. Output ONLY the title, nothing else. No quotes. No punctuation.\n\n${conversation}`;
  }

  log('tab naming: asking haiku for', sessionId);

  execFile('claude', ['-p', '--model', 'haiku', '--no-session-persistence'], {
    env: getCleanEnv(),
    timeout: 30000,
  }, (err, stdout) => {
    if (err) {
      log('tab naming: haiku failed:', err.message);
      return;
    }
    const name = stdout.trim();
    if (!name || name.length > 40) {
      log('tab naming: bad result:', name);
      return;
    }

    log('tab naming:', sessionId, '→', name);
    nameCache[sessionId] = name;
    saveNameCache();
    tabNames.set(tabId, name);
    broadcastSessions();

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tab:rename', tabId, name);
    }
  }).stdin!.end(prompt);
}

// Right-click context menu for tabs
ipcMain.on('tab:context-menu', (_e, tabId: string) => {
  const sessionId = tabSessionIds.get(tabId);

  const menu = Menu.buildFromTemplate([
    {
      label: 'Rename...',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('tab:start-rename', tabId);
        }
      },
    },
    {
      label: 'Regenerate Name',
      enabled: !!sessionId,
      click: () => {
        if (!sessionId) return;
        const jsonlPath = findSessionJSONL(sessionId);
        if (!jsonlPath) {
          log('regenerate: no JSONL found for', sessionId);
          return;
        }
        const pairs = readConversationPairs(jsonlPath, 5);
        if (pairs.length) {
          generateName(sessionId, tabId, pairs);
        }
      },
    },
  ]);

  menu.popup();
});

// Manual rename from inline editing
ipcMain.on('tab:set-name', (_e, tabId: string, name: string) => {
  const sessionId = tabSessionIds.get(tabId);
  if (sessionId && name.trim()) {
    nameCache[sessionId] = name.trim();
    saveNameCache();
    log('manual rename:', sessionId, '→', name.trim());
  }
  tabNames.set(tabId, name.trim());
  broadcastSessions();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('tab:rename', tabId, name.trim());
  }
});

let savedHeight: number | null = null;
let barModeActive = false;
const TAB_BAR_HEIGHT = 36;

function setBarMode(enabled: boolean) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (barModeActive === enabled) return;
  barModeActive = enabled;
  const bounds = mainWindow.getBounds();
  if (enabled) {
    savedHeight = bounds.height;
    mainWindow.setBounds({ ...bounds, height: TAB_BAR_HEIGHT });
  } else if (savedHeight) {
    mainWindow.setBounds({ ...bounds, height: savedHeight });
    savedHeight = null;
  }
  mainWindow.webContents.send('app:bar-mode-changed', enabled);
  log('bar mode:', enabled);
}

ipcMain.on('app:bar-mode', (_e, enabled: boolean) => setBarMode(enabled));

// Bar lock — global arrow key capture using keyspy (CGEventTap)
let barLocked = false;

function setBarLocked(locked: boolean) {
  if (barLocked === locked) return;
  barLocked = locked;
  log('bar lock:', locked);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:bar-lock', locked);
  }
}

ipcMain.on('app:toggle-bar-lock', () => {
  setBarLocked(!barLocked);
});

let panelNavActive = false;
ipcMain.on('app:panel-nav', (_e, active: boolean) => {
  panelNavActive = active;
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { GlobalKeyboardListener } = require('keyspy');
const keyListener = new GlobalKeyboardListener();

keyListener.addListener((e: { name: string; state: string }, down: Record<string, boolean>) => {
  if (e.state !== 'DOWN') return;

  const hasOption = down['LEFT ALT'] || down['RIGHT ALT'];
  const hasCmd = down['LEFT META'] || down['RIGHT META'];
  const hasOther = down['LEFT CTRL'] || down['RIGHT CTRL'] ||
                   down['LEFT SHIFT'] || down['RIGHT SHIFT'];

  // Option+Slash = close active tab
  if (e.name === 'FORWARD SLASH' && hasOption && !hasCmd && !hasOther) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:close-tab');
    }
    return true;
  }

  // Option+Enter → open session from panel nav, suppress
  if (e.name === 'RETURN' && hasOption && !hasCmd && !hasOther) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:enter');
    }
    return true;
  }

  const isArrow = e.name === 'LEFT ARROW' || e.name === 'RIGHT ARROW' ||
                  e.name === 'UP ARROW' || e.name === 'DOWN ARROW';
  if (!isArrow) return;

  // Option+Up = collapse bar, Option+Down = expand bar
  if (hasOption && !hasCmd && !hasOther) {
    if (e.name === 'UP ARROW') { setBarMode(true); return true; }
    if (e.name === 'DOWN ARROW') { setBarMode(false); return true; }
    return;
  }

  // Cmd+Up = lock arrows, Cmd+Down = unlock arrows
  if (hasCmd && !hasOption && !hasOther) {
    if (e.name === 'UP ARROW') { setBarLocked(true); return true; }
    if (e.name === 'DOWN ARROW') { setBarLocked(false); return true; }
    return;
  }

  // Bare arrows when locked → forward to renderer, suppress
  // Left/right always; up/down only during panel nav
  if (barLocked && !hasOption && !hasCmd && !hasOther) {
    if (e.name === 'LEFT ARROW' || e.name === 'RIGHT ARROW') {
      const dir = e.name === 'LEFT ARROW' ? 'left' : 'right';
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app:arrow', dir);
      }
      return true;
    }
    if (panelNavActive && (e.name === 'UP ARROW' || e.name === 'DOWN ARROW')) {
      const dir = e.name === 'UP ARROW' ? 'up' : 'down';
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app:arrow', dir);
      }
      return true;
    }
  }
});

ipcMain.on('pty:write', (_e, id: string, data: string) => {
  if (id.startsWith('pi-')) { piSend({ type: 'input', tabId: id, data }); }
  else { ptySessions.get(id)?.write(data); }
});
ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => {
  if (id.startsWith('pi-')) { piSend({ type: 'resize', tabId: id, cols, rows }); }
  else { ptySessions.get(id)?.resize(cols, rows); }
});

ipcMain.on('pty:kill', (_e, id: string) => {
  if (id.startsWith('pi-')) { piSend({ type: 'kill_tab', tabId: id }); return; }
  log('pty:kill called for', id);
  ptySessions.get(id)?.kill();
  ptySessions.delete(id);
  tabNames.delete(id);
  tabWorking.delete(id);
  scrollback.delete(id);
  wsClients.delete(id);
  broadcastSessions();
});

let voiceControl: { stop: () => void } | null = null;

// Kill all PTY processes on app quit
app.on('before-quit', () => {
  voiceControl?.stop();
  keyListener.kill();
  wsServer.close();
  for (const proc of ptySessions.values()) {
    proc.kill();
  }
  ptySessions.clear();
});

app.on('ready', () => {
  log('app ready');

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minHeight: 1,
    alwaysOnTop: true,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.webContents.on('did-finish-load', () => log('renderer loaded'));
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => log('FAILED', url, code, desc));
  mainWindow.webContents.on('console-message', (_e, _level, msg) => log('[renderer]', msg));

  connectToPi();

  voiceControl = initVoice({
    ptySessions,
    getActiveTabId: () => activeTabId,
    getMainWindow: () => mainWindow,
    log,
  });

  const url = MAIN_WINDOW_VITE_DEV_SERVER_URL;
  log('vite url:', url);

  const tryLoad = (attempts = 0) => {
    (url ? mainWindow.loadURL(url) : mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)))
      .catch((err) => {
        log(`load attempt ${attempts} failed: ${err.message}`);
        if (attempts < 20) setTimeout(() => tryLoad(attempts + 1), 500);
      });
  };
  tryLoad();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) app.emit('ready'); });
