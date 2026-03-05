import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import http from 'node:http';
import { execSync, execFile } from 'node:child_process';
import started from 'electron-squirrel-startup';
import pty from 'node-pty';
import { initVoice } from './voice';
import { loadConfig } from './config';

if (started) app.quit();

fs.writeFileSync('/tmp/ai-terminal.log', '');
const log = (...args: unknown[]) => {
  const line = `[main] ${args.join(' ')}\n`;
  process.stdout.write(line);
  fs.appendFileSync('/tmp/ai-terminal.log', line);
};
log('main process starting');

const TMUX = '/opt/homebrew/bin/tmux';
const tmuxSessions = new Map<string, string>(); // tab id → tmux session name
const ptySessions = new Map<string, ReturnType<typeof pty.spawn>>();
let activeTabId: string | null = null;
let mainWindow: BrowserWindow | null = null;

ipcMain.on('tab:active', (_e, id: string) => {
  activeTabId = id;
  fs.writeFileSync('/tmp/ai-terminal-active-tab', id);
  log('active tab:', id);
});

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

ipcMain.handle('pty:create', (event, id: string, resumeSessionId?: string) => {
  const sessionName = `ai-tab-${id.slice(0, 8)}`;
  log('creating tmux session:', sessionName, resumeSessionId ? `(resuming ${resumeSessionId})` : '');

  const env = getCleanEnv();

  // Create a detached tmux session running claude
  const cwd = path.join(os.homedir(), 'workspace');
  const claudeCmd = resumeSessionId
    ? `claude --dangerously-skip-permissions --resume '${resumeSessionId}'`
    : 'claude --dangerously-skip-permissions';
  try {
    execSync(
      `${TMUX} new-session -d -s '${sessionName}' -x 80 -y 24 -c '${cwd}' '${claudeCmd}'`,
      { env },
    );
    execSync(`${TMUX} set-option -t '${sessionName}' status off`, { env });
  } catch (err) {
    log('tmux new-session failed:', (err as Error).message);
    throw err;
  }

  tmuxSessions.set(id, sessionName);

  // Attach to the tmux session via PTY so xterm.js can render it
  const ptyProcess = pty.spawn(TMUX, ['attach-session', '-t', sessionName], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd,
    env,
  });

  ptySessions.set(id, ptyProcess);
  ptyProcess.onData((data) => { if (!event.sender.isDestroyed()) event.sender.send(`pty:data:${id}`, data); });
  ptyProcess.onExit(({ exitCode, signal }) => {
    log(`pty exited: ${id} exitCode=${exitCode} signal=${signal}`);
    ptySessions.delete(id);
    if (!event.sender.isDestroyed()) event.sender.send(`pty:exit:${id}`);
  });

  // For resumed sessions, apply cached name + notify renderer of mapping
  if (resumeSessionId) {
    tabSessionIds.set(id, resumeSessionId);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tab:session-mapped', id, resumeSessionId);
      if (nameCache[resumeSessionId]) {
        mainWindow.webContents.send('tab:rename', id, nameCache[resumeSessionId]);
      }
    }
  }
  // For new sessions, the Stop hook will POST /session-id after first exchange,
  // which triggers naming automatically.

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
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('tab:rename', tabId, name.trim());
  }
});

ipcMain.on('pty:write', (_e, id: string, data: string) => ptySessions.get(id)?.write(data));
ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => {
  ptySessions.get(id)?.resize(cols, rows);
  // Also resize the tmux session so it matches
  const sessionName = tmuxSessions.get(id);
  if (sessionName) {
    execFile(TMUX, ['resize-window', '-t', sessionName, '-x', String(cols), '-y', String(rows)], (_err) => { /* ignore */ });
  }
});

ipcMain.on('pty:kill', (_e, id: string) => {
  log('pty:kill called for', id);
  const sessionName = tmuxSessions.get(id);
  if (sessionName) {
    execFile(TMUX, ['kill-session', '-t', sessionName], (err) => {
      if (err) log('tmux kill-session failed:', err.message);
      else log('tmux session killed:', sessionName);
    });
    tmuxSessions.delete(id);
  }
  ptySessions.get(id)?.kill();
  ptySessions.delete(id);
});

let voiceControl: { stop: () => void } | null = null;

// Kill all ai-tab tmux sessions on app quit
app.on('before-quit', () => {
  voiceControl?.stop();
  for (const [id, sessionName] of tmuxSessions) {
    try { execSync(`${TMUX} kill-session -t '${sessionName}'`); } catch (_e) { /* ignore */ }
    tmuxSessions.delete(id);
  }
});

app.on('ready', () => {
  log('app ready');

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.webContents.on('did-finish-load', () => log('renderer loaded'));
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => log('FAILED', url, code, desc));
  mainWindow.webContents.on('console-message', (_e, _level, msg) => log('[renderer]', msg));

  voiceControl = initVoice({
    tmuxSessions,
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
