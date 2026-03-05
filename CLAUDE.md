# ai-terminal

History-powered Claude Code session manager. Electron + React + Vite + node-pty + xterm.js.

## Stack
- Electron main process — tmux session lifecycle, HTTP IPC server, voice control, session discovery
- React + Vite renderer — tab UI, session panel, xterm.js terminals
- node-pty — PTY spawning (attaches to tmux sessions)
- @xterm/xterm + @xterm/addon-fit — terminal rendering
- uiohook-napi — global keyboard monitoring for voice (Right Shift)

## Running
```
npm start   # from iTerm2 or Terminal — NOT from inside Claude Code
```

## Key Files
- `src/main.ts` — main process: tmux management, IPC server, session listing, tab naming, voice init
- `src/voice.ts` — native voice control: uiohook, sox recording, whisper transcription, tmux delivery
- `src/App.tsx` — tab bar, session panel, drag-and-drop, inline rename, voice indicator
- `src/TerminalTab.tsx` — xterm.js terminal, PTY wiring, fit/resize
- `src/preload.ts` — contextBridge: exposes window.pty, window.sessions, window.voice
- `src/global.d.ts` — TypeScript types for Window interface + SessionInfo
- `src/App.css` — dark UI styles

## Architecture

### Session Lifecycle
1. Tab created → tmux session spawned → claude starts inside it
2. Stop hook fires after first exchange → reports session UUID to app via HTTP
3. App maps tab ID → session UUID → triggers Haiku naming
4. Name cached locally + written to history for cross-device sync

### History Integration
History is the core data layer, not an add-on. The Stop hook logs every exchange
with session IDs. The session list reads primarily from history, with JSONL as fallback.
Tab names are stored in history so they sync across devices.

### Session ID Discovery
The Stop hook receives `transcript_path` from Claude Code, which contains the session UUID
as the filename stem. It POSTs `{tabId, sessionId}` to the app's IPC server at `/session-id`.
The tab ID comes from `/tmp/ai-terminal-active-tab`.

### PTY / tmux Setup
Each tab spawns a tmux session (`ai-tab-{id.slice(0,8)}`), then attaches via node-pty.
Clean env vars to prevent nested session errors:
- `CLAUDECODE`, `CLAUDE_SESSION_ID`, `ELECTRON_RUN_AS_NODE`, `ELECTRON_NO_ATTACH_CONSOLE`

### Voice Control
Native in the Electron main process via `src/voice.ts`:
- Right Shift: start/stop recording (global, even when app unfocused)
- sox for recording, whisper.cpp / OpenAI API for transcription (adaptive by duration)
- Delivery via `tmux send-keys` to the active tab's tmux session
- Voice substitutions from `~/pi-data/voice_subs.json`

### IPC Server (port 27182)
- `POST /rename` — rename a tab `{tabId, title}`
- `POST /session-id` — map tab to Claude session `{tabId, sessionId}`
- `GET /active-tab` — returns `{tabId}` for the active tab

### Tab Naming
- Auto: after first exchange, Haiku generates a 2-3 word title from the first user message
- Regenerate: right-click tab → feeds last 5 user/assistant text pairs to Haiku
- Manual: right-click tab → inline text input
- Names cached in `{historyDir}/tab-names.json` (syncs with history data)

### Session List
- Primary source: history data (covers all channels — Mac, Telegram, Pi, phone)
- Fallback: JSONL files in `~/.claude/projects/*/`
- Filters out naming sessions (prompt pattern: "Give a 2-3 word tab title")
- Prefers cached Haiku names over raw first messages
