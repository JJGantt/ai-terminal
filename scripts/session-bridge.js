#!/usr/bin/env node
/**
 * ai-terminal session bridge — Stop hook that fires after every Claude Code response.
 *
 * 1. Reports the Claude session UUID to the app (for tab identity + naming)
 * 2. Logs the exchange to local history (for the session browser)
 * 3. Syncs the exchange to the peer node (Pi) for cross-device availability
 *
 * Config sources:
 *   ~/.ai-terminal/config.json   — historyDir
 *   ~/mcp-history/config.json    — peer sync settings
 *
 * Stdin: JSON payload from Claude Code (transcript_path, last_assistant_message, cwd)
 * Active tab ID: /tmp/ai-terminal-active-tab
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

const APP_PORT = 27182;
const ACTIVE_TAB_FILE = '/tmp/ai-terminal-active-tab';
const APP_CONFIG_PATH = path.join(os.homedir(), '.ai-terminal', 'config.json');
const HISTORY_CONFIG_PATH = path.join(os.homedir(), 'mcp-history', 'config.json');

function getHistoryDir() {
  try {
    const raw = JSON.parse(fs.readFileSync(APP_CONFIG_PATH, 'utf-8'));
    return (raw.historyDir || '').replace(/^~/, os.homedir());
  } catch {
    return path.join(os.homedir(), '.ai-terminal', 'history');
  }
}

function getPeerConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(HISTORY_CONFIG_PATH, 'utf-8'));
    return raw.peer || null;
  } catch {
    return null;
  }
}

function postLocal(urlPath, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: APP_PORT,
      path: urlPath,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
      timeout: 3000,
    }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end(data);
  });
}

function postPeer(hostname, port, urlPath, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname,
      port,
      path: urlPath,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
      timeout: 5000,
    }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end(data);
  });
}

function extractUserText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(b => b && b.type === 'text')
      .map(b => b.text)
      .join(' ')
      .trim();
  }
  return String(content);
}

function getLastUserMessage(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return '';
  let lastUser = '';
  for (const line of fs.readFileSync(transcriptPath, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user') {
        const text = extractUserText(entry.message?.content || '');
        if (text) lastUser = text;
      }
    } catch {}
  }
  return lastUser;
}

async function syncToPeer(entry) {
  const peer = getPeerConfig();
  if (!peer) return;

  const port = peer.receiver_port || 8767;
  const hosts = [peer.local_ip, peer.tailscale_ip].filter(Boolean);

  for (const host of hosts) {
    if (await postPeer(host, port, '/log', entry)) return;
  }
  // Both hosts failed — silently drop (will sync via rsync later)
}

async function main() {
  let payload;
  try {
    const stdin = fs.readFileSync(0, 'utf-8');
    payload = JSON.parse(stdin);
  } catch {
    process.exit(0);
  }

  const { transcript_path, last_assistant_message, cwd } = payload;
  if (!last_assistant_message?.trim()) process.exit(0);

  const sessionId = transcript_path ? path.basename(transcript_path, '.jsonl') : null;
  const userMsg = getLastUserMessage(transcript_path);

  // Skip naming sessions
  if (userMsg.includes('Give a 2-3 word tab title')) process.exit(0);

  // 1. Report session ID to the app (once per tab)
  let tabId = '';
  try { tabId = fs.readFileSync(ACTIVE_TAB_FILE, 'utf-8').trim(); } catch {}

  if (tabId && sessionId) {
    const markerDir = '/tmp/ai-terminal-reported';
    try { fs.mkdirSync(markerDir, { recursive: true }); } catch {}
    const marker = path.join(markerDir, tabId);
    if (!fs.existsSync(marker)) {
      await postLocal('/session-id', { tabId, sessionId });
      fs.writeFileSync(marker, sessionId);
    }
  }

  // 2. Log to local history
  if (!userMsg) process.exit(0);

  const historyDir = getHistoryDir();
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const historyFile = path.join(historyDir, `${dateStr}.json`);

  try { fs.mkdirSync(historyDir, { recursive: true }); } catch {}

  let entries = [];
  try { entries = JSON.parse(fs.readFileSync(historyFile, 'utf-8')); } catch {}

  const source = process.env.CLAUDE_SOURCE || 'claude-mac';
  const entry = {
    timestamp: now.toISOString(),
    source,
    user: userMsg,
    claude: last_assistant_message.trim(),
    ...(sessionId && { session_id: sessionId }),
    ...(cwd && { cwd }),
  };

  entries.push(entry);
  fs.writeFileSync(historyFile, JSON.stringify(entries, null, 2));

  // 3. Sync to peer (non-blocking — don't hold up Claude Code)
  syncToPeer(entry).catch(() => {});
}

main().catch(() => process.exit(0));
