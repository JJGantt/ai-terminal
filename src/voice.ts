import { spawn, execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { uIOhook, UiohookKey } from 'uiohook-napi';
import { systemPreferences, BrowserWindow } from 'electron';

type State = 'idle' | 'recording' | 'transcribing';

interface VoiceDeps {
  tmuxSessions: Map<string, string>;
  getActiveTabId: () => string | null;
  getMainWindow: () => BrowserWindow | null;
  log: (...args: unknown[]) => void;
}

const SOX = '/opt/homebrew/bin/sox';
const WHISPER = path.join(os.homedir(), 'whisper.cpp/build/bin/whisper-cli');
const WHISPER_MODEL = path.join(os.homedir(), 'whisper.cpp/models/ggml-base.en.bin');
const TMUX = '/opt/homebrew/bin/tmux';
const SUBS_PATH = path.join(os.homedir(), 'pi-data/voice_subs.json');
const OPENAI_KEY_FILE = path.join(os.homedir(), '.config/openai-api-key');
const SOUNDS = '/System/Library/Sounds';
const WAV_PATH = '/tmp/ai-terminal-voice.wav';
const WATCHDOG_MS = 60_000;
const ADAPTIVE_THRESHOLD_S = 15;

function playSound(name: string) {
  spawn('afplay', [path.join(SOUNDS, `${name}.aiff`)], { detached: true, stdio: 'ignore' }).unref();
}

function loadSubs(): Array<{ word: string; replacement: string }> {
  try {
    const data = JSON.parse(fs.readFileSync(SUBS_PATH, 'utf-8'));
    return data.subs || [];
  } catch {
    return [];
  }
}

function applySubs(text: string): string {
  const subs = loadSubs();
  let result = text;
  for (const { word, replacement } of subs) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(escaped, 'gi'), replacement);
  }
  return result.trim();
}

export function initVoice(deps: VoiceDeps): { stop: () => void } {
  const { tmuxSessions, getActiveTabId, getMainWindow, log } = deps;

  let state: State = 'idle';
  let soxProc: ChildProcess | null = null;
  let sendEnter = false;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let recordingStartedAt = 0;
  let recordingTabId: string | null = null;

  // Check permissions
  const trusted = systemPreferences.isTrustedAccessibilityClient(true);
  log('accessibility trusted:', trusted);
  systemPreferences.askForMediaAccess('microphone').then(granted => {
    log('microphone permission:', granted ? 'granted' : 'denied');
  });

  function setState(next: State) {
    state = next;
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('voice:state', next, recordingTabId);
    }
    log('voice state:', next, 'tab:', recordingTabId);
  }

  function resetWatchdog() {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      if (state !== 'idle') {
        log('voice: watchdog triggered, resetting from', state);
        cancelRecording();
      }
    }, WATCHDOG_MS);
  }

  function startRecording() {
    if (state !== 'idle') return;

    sendEnter = true;
    recordingStartedAt = Date.now();
    recordingTabId = getActiveTabId();
    setState('recording');
    playSound('Glass');
    resetWatchdog();

    // Clean up any old wav
    try { fs.unlinkSync(WAV_PATH); } catch { /* ignore */ }

    soxProc = spawn(SOX, ['-d', '-r', '16000', '-c', '1', '-b', '16', WAV_PATH], {
      stdio: 'ignore',
    });

    soxProc.on('error', (err) => {
      log('voice: sox error:', err.message);
      setState('idle');
    });
  }

  function onTranscribed(text: string | null) {
    if (watchdog) clearTimeout(watchdog);
    if (!text) {
      log('voice: empty transcription');
      recordingTabId = null;
      setState('idle');
      return;
    }
    const cleaned = applySubs(text);
    log('voice: transcribed:', cleaned);
    deliverText(cleaned, sendEnter);
    recordingTabId = null;
    setState('idle');
  }

  function transcribeLocal(cb: (text: string | null) => void) {
    execFile(WHISPER, ['-m', WHISPER_MODEL, '-f', WAV_PATH, '--no-prints', '-nt'], (err, stdout) => {
      if (err) {
        log('voice: whisper error:', err.message);
        cb(null);
        return;
      }
      cb(stdout.trim() || null);
    });
  }

  function transcribeAPI(cb: (text: string | null) => void) {
    let apiKey: string;
    try {
      apiKey = fs.readFileSync(OPENAI_KEY_FILE, 'utf-8').trim();
    } catch {
      log('voice: no API key, falling back to local');
      transcribeLocal(cb);
      return;
    }

    execFile('/usr/bin/curl', [
      '-sS', '-X', 'POST',
      'https://api.openai.com/v1/audio/transcriptions',
      '-H', `Authorization: Bearer ${apiKey}`,
      '-F', `file=@${WAV_PATH}`,
      '-F', 'model=whisper-1',
      '-F', 'response_format=json',
      '-F', 'language=en',
    ], (err, stdout) => {
      if (err) {
        log('voice: API error, falling back to local:', err.message);
        transcribeLocal(cb);
        return;
      }
      try {
        const json = JSON.parse(stdout);
        cb(json.text?.trim() || null);
      } catch {
        log('voice: API parse error, falling back to local:', stdout.slice(0, 200));
        transcribeLocal(cb);
      }
    });
  }

  function stopAndTranscribe() {
    if (state !== 'recording' || !soxProc) return;

    // Kill sox to finalize the wav file
    soxProc.kill('SIGTERM');
    soxProc = null;
    playSound('Purr');

    setState('transcribing');
    resetWatchdog();

    const durationS = (Date.now() - recordingStartedAt) / 1000;
    const useAPI = durationS >= ADAPTIVE_THRESHOLD_S;
    log(`voice: recording was ${durationS.toFixed(1)}s, using ${useAPI ? 'API' : 'local'}`);

    // Small delay for file to finalize
    setTimeout(() => {
      if (!fs.existsSync(WAV_PATH)) {
        log('voice: no wav file found');
        setState('idle');
        return;
      }

      if (useAPI) {
        transcribeAPI(onTranscribed);
      } else {
        transcribeLocal(onTranscribed);
      }
    }, 200);
  }

  function cancelRecording() {
    if (soxProc) {
      soxProc.kill('SIGTERM');
      soxProc = null;
    }
    if (watchdog) clearTimeout(watchdog);
    recordingTabId = null;
    setState('idle');
    log('voice: cancelled');
  }

  function deliverText(text: string, withEnter: boolean) {
    const tabId = recordingTabId;
    if (!tabId) { log('voice: no recording tab'); return; }
    const sessionName = tmuxSessions.get(tabId);
    if (!sessionName) { log('voice: no tmux session for tab', tabId); return; }

    const safe = text.replace(/'/g, '');
    execFile(TMUX, ['send-keys', '-t', sessionName, '-l', safe], (err) => {
      if (err) { log('voice: send-keys text failed', err.message); return; }
      log('voice: text sent to', sessionName);
      if (withEnter) {
        setTimeout(() => {
          execFile(TMUX, ['send-keys', '-t', sessionName, 'Enter'], (err2) => {
            if (err2) log('voice: send-keys Enter failed', err2.message);
            else log('voice: Enter sent to', sessionName);
          });
        }, 100);
      }
    });
  }

  // Key listener via uiohook
  // Right Shift keycode: 0x0036 (54 decimal) is the macOS virtual keycode
  // uiohook uses its own key codes — UiohookKey.ShiftRight
  uIOhook.on('keydown', (e) => {
    if (e.keycode === UiohookKey.ShiftRight) {
      if (state === 'idle') {
        startRecording();
      } else if (state === 'recording') {
        stopAndTranscribe();
      }
    } else if (state === 'recording') {
      if (e.keycode === UiohookKey.Enter) {
        sendEnter = true;
        stopAndTranscribe();
      } else if (e.keycode === UiohookKey.Escape) {
        cancelRecording();
      }
    }
  });

  uIOhook.start();
  log('voice: uiohook started, listening for Right Shift');

  return {
    stop() {
      uIOhook.stop();
      if (soxProc) { soxProc.kill('SIGTERM'); soxProc = null; }
      if (watchdog) clearTimeout(watchdog);
      log('voice: stopped');
    },
  };
}
