#!/usr/bin/env python3
"""
Called by the Claude Code Stop hook to name ai-terminal tabs.

Only fires once per tab — creates a marker file after naming.
Reads the active tab ID from /tmp/ai-terminal-active-tab,
asks Haiku for a 2-3 word title, and POSTs it to the app.

Forks to background immediately so it doesn't block the hook.
"""

import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

MARKER_DIR = Path("/tmp/ai-terminal-named")
ACTIVE_TAB_FILE = Path("/tmp/ai-terminal-active-tab")
APP_URL = "http://127.0.0.1:27182/rename"
LOG = Path("/tmp/ai-terminal-namer.log")


def log(msg: str):
    with open(LOG, "a") as f:
        f.write(f"{msg}\n")


def main():
    # Read the hook payload from stdin before forking
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw)
    except Exception:
        sys.exit(0)

    transcript_path = payload.get("transcript_path", "")

    # Get active tab ID early — if no tab file, this isn't an ai-terminal session
    try:
        tab_id = ACTIVE_TAB_FILE.read_text().strip()
    except Exception:
        sys.exit(0)

    if not tab_id:
        sys.exit(0)

    # Check marker before forking — fast exit if already named
    MARKER_DIR.mkdir(exist_ok=True)
    marker = MARKER_DIR / tab_id
    if marker.exists():
        sys.exit(0)

    # Fork to background so we don't block the hook
    pid = os.fork()
    if pid != 0:
        sys.exit(0)  # Parent exits immediately, unblocking the hook
    os.setsid()

    log("tab_namer running (background)")
    log(f"transcript_path: {transcript_path}")
    log(f"tab_id: {tab_id}")

    # Read the FIRST user message from the transcript
    user_msg = ""
    if transcript_path:
        try:
            for line in Path(transcript_path).read_text().splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if entry.get("type") == "user":
                    content = entry.get("message", {}).get("content", "")
                    if isinstance(content, str) and content.strip():
                        user_msg = content.strip()
                        break  # First user message only
                    elif isinstance(content, list):
                        parts = [b["text"] for b in content if isinstance(b, dict) and b.get("type") == "text"]
                        text = " ".join(parts).strip()
                        if text:
                            user_msg = text
                            break  # First user message only
        except Exception as e:
            log(f"failed to read transcript: {e}")

    log(f"user_msg: {user_msg[:100]!r}")

    if not user_msg:
        log("no user message, exiting")
        sys.exit(0)

    # Mark as named NOW to prevent duplicate runs
    marker.touch()

    # Ask Haiku for a title
    prompt = f"Give a 2-3 word tab title for this user message. Output ONLY the title, nothing else. No quotes. No punctuation.\n\nUser message: {user_msg[:500]}"
    log("calling haiku...")
    try:
        result = subprocess.run(
            ["claude", "-p", "--model", "haiku"],
            input=prompt,
            capture_output=True,
            text=True,
            timeout=30,
        )
        title = result.stdout.strip()
        log(f"haiku returned: {title!r} (exit={result.returncode})")
    except Exception as e:
        log(f"haiku call failed: {e}")
        sys.exit(0)

    if not title or len(title) > 40:
        log("bad title, exiting")
        sys.exit(0)

    # POST to the app
    log(f"posting rename: {tab_id} -> {title}")
    try:
        body = json.dumps({"tabId": tab_id, "title": title}).encode()
        req = urllib.request.Request(
            APP_URL,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        resp = urllib.request.urlopen(req, timeout=5)
        log(f"post response: {resp.status}")
    except Exception as e:
        log(f"post failed: {e}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"uncaught exception: {e}")
