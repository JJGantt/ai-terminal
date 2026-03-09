# ai-terminal — To Do

## Desktop Notifications
When Claude finishes on a background tab → macOS notification via Electron.
Already have the `✳` title signal. Click notification to jump to that tab.

## Response Pop-ups / Floating Panels
Instead of switching tabs to see what Claude said, show the response as a floating
overlay or sidebar on the desktop. Small frameless always-on-top Electron window.
Reply from there (text or voice) without switching to the full app. Like a "mini view"
per tab.

## Hotkey-per-tab Voice
Send voice directly to a specific tab without switching to it. e.g. Ctrl+1+Right Shift
→ record → send to tab 1. Or a picker: start recording, then choose destination.

## Tab Activity Feed
Richer status than spinner/done — show what tool Claude is using, what file it's editing,
a one-line summary. PTY stream has tool names. Could also reuse the session watcher
summarization (already does this for Telegram).
