# ai-terminal — Vision

A history-powered session manager for Claude Code. Browse, resume, and manage
sessions across devices — with native voice control and automatic tab naming.

## Why This Exists

Claude Code sessions are scattered across JSONL files with no way to browse,
search, or resume them easily. There's no cross-device awareness — you can't
see what happened on your phone from your Mac, or pick up a Telegram session
in a terminal. This app makes all sessions first-class, searchable, and resumable.

## Core Architecture

**History is the backbone.** Every exchange is logged with session IDs, sources,
and timestamps. The session list, tab naming, and cross-device sync all flow
from this. Without history, it's just a terminal wrapper. With it, it's a
unified session manager.

### Data Flow
1. Claude Code runs inside tmux sessions (one per tab)
2. Stop hook fires after every exchange → logs to history, reports session ID to app
3. App discovers session ID → triggers Haiku tab naming → caches name in history
4. Session list reads from history (primary) + JSONL files (fallback), refreshes every 30s
5. History syncs to other devices → sessions available everywhere

### Session Identity
- Each tab gets a random UUID at creation
- The Stop hook reports the Claude session UUID back to the app via HTTP IPC
- The app maps tab UUID → Claude session UUID for naming and resuming
- Resumed sessions already know their Claude session UUID

## Features

### Session Manager (Left Panel)
- Browse all sessions: local, Telegram, Pi, phone — anything with history
- Progressive loading: last 24h immediate, then expandable date groups
- Haiku-generated 2-3 word names for every session
- Click to resume any session in a new tab (deduplicates already-open sessions)
- Right-click tabs: rename manually or regenerate name from conversation context
- Right-click sessions: hide from list

### Tabbed Claude Sessions
- Each tab is a tmux session running `claude --dangerously-skip-permissions`
- Drag-and-drop tab reordering via @dnd-kit/sortable
- Auto-naming via Haiku after first exchange
- Bare arrow keys to switch tabs; Option+arrows for cursor movement in terminal
- File drag-and-drop pastes file paths into terminal
- Pop out to iTerm: right-click → Open in Terminal (detaches and opens in iTerm)

### Native Voice Control
- Right Shift (global, via uiohook-napi): start/stop recording in current tab
- Right Option + Right Shift: open new tab + start recording simultaneously
- Enter while recording: transcribe + submit
- Escape: cancel recording
- Adaptive transcription: <15s local whisper.cpp, >=15s OpenAI Whisper API
- Voice substitutions from shared config
- Visual indicator: red pulsing dot (recording), amber (transcribing) — on the recording tab
- Recording targets the tab that was active at recording start, not at finish

### Cross-Device (Optional Layer)
- History syncs bidirectionally between Mac and Pi
- Pi is always-on — phone sessions always available on Mac
- Mac sessions available on phone when Mac is on
- Same UI could run on phone, backed by the same history data

## The Hub

ai-terminal is the unified interface for everything — not just Claude sessions.
The Python MCP servers, Telegram bots, and TV dashboard all serve the same data
through different interfaces. This app consolidates them into one codebase.

### Integrated Modules (future — replacing Python MCPs)
- **Sessions** — browse, resume, search across all devices and channels
- **Lists** — todos, grocery, custom lists (replaces mcp-data list functions)
- **Workouts** — logging, progression history, charts (replaces mcp-data workout functions)
- **Nutrition** — food logging, recipes, daily totals (replaces mcp-data nutrition functions)
- **Reminders** — with actual native notifications
- **Notes** — proper editor UI
- **Dashboard** — interactive version of the TV dashboard
- **Lights** — Govee control (replaces govee-mcp)

Each module is a JS/TS internal module, not a separate process. Data is JSON,
same format as today, same sync mechanism. The left panel becomes a nav bar
between sessions and these views.

### Planned: Quick Hotkey Commands
Modifier combos that attach context to voice recordings, usable from anywhere:
- Screenshot + voice: capture screen and record a voice message together
- Clipboard + voice: paste clipboard content with a voice instruction
- General pattern: hotkey captures context, starts recording, sends both to a tab

## For Other Users

Self-contained. Install it, it sets up:
1. The Stop hook in `~/.claude/settings.json` (session ID reporting + history logging)
2. Local history storage
3. Tab name cache

No external dependencies beyond Claude Code itself and sox/whisper for voice.
Cross-device sync is opt-in — the app works fully standalone on one machine.

## IPC

Local HTTP server on port 27182:
- `POST /rename` — rename a tab (used by naming system)
- `POST /session-id` — report Claude session UUID for a tab (used by Stop hook)
- `GET /active-tab` — get the active tab ID (used by hook + voice)
