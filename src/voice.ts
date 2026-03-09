import { spawn, execFile, execFileSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { uIOhook, UiohookKey } from 'uiohook-napi';
import { systemPreferences, BrowserWindow, ipcMain } from 'electron';

type State = 'idle' | 'recording' | 'transcribing';

interface VoiceDeps {
  ptySessions: Map<string, { write: (data: string) => void }>;
  getActiveTabId: () => string | null;
  getMainWindow: () => BrowserWindow | null;
  log: (...args: unknown[]) => void;
}

const SOX = '/opt/homebrew/bin/sox';
const WHISPER = path.join(os.homedir(), 'whisper.cpp/build/bin/whisper-cli');
const WHISPER_MODEL = path.join(os.homedir(), 'whisper.cpp/models/ggml-base.en.bin');
const SUBS_PATH = path.join(os.homedir(), 'pi-data/voice_subs.json');
const OPENAI_KEY_FILE = path.join(os.homedir(), '.config/openai-api-key');
const GET_SELECTION = path.join(__dirname, '../../native/get-selection');
const SOUNDS = '/System/Library/Sounds';
const WAV_PATH = '/tmp/ai-terminal-voice.wav';
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
  const { ptySessions, getActiveTabId, getMainWindow, log } = deps;

  let state: State = 'idle';
  let soxProc: ChildProcess | null = null;
  let sendEnter = false;
  let recordingStartedAt = 0;
  let recordingTabId: string | null = null;
  let rightOptionHeld = false;
  let capturedSelection: string | null = null;

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

  function grabSelection() {
    try {
      log('voice: grabSelection path:', GET_SELECTION);
      const text = execFileSync(GET_SELECTION, { timeout: 1000, encoding: 'utf-8' }).trim();
      log('voice: grabSelection result:', text ? text.slice(0, 80) : '(empty)');
      return text || null;
    } catch (err) {
      log('voice: grabSelection error:', (err as Error).message);
      return null;
    }
  }

  function startRecording() {
    if (state !== 'idle') return;

    capturedSelection = grabSelection();
    if (capturedSelection) log('voice: captured selection:', capturedSelection.slice(0, 100));

    sendEnter = true;
    recordingStartedAt = Date.now();
    recordingTabId = getActiveTabId();
    setState('recording');
    playSound('Glass');

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

    capturedSelection = null;
    recordingTabId = null;
    setState('idle');
    log('voice: cancelled');
  }

  function deliverText(text: string, withEnter: boolean) {
    const tabId = recordingTabId;
    if (!tabId) { log('voice: no recording tab'); return; }
    const ptyProcess = ptySessions.get(tabId);
    if (!ptyProcess) { log('voice: no pty for tab', tabId); return; }

    let output = '';
    if (capturedSelection) {
      const quoted = capturedSelection.split('\n').map(l => `> ${l}`).join('\n');
      output = `[Highlighted text:]\n${quoted}\n\n${text}`;
      capturedSelection = null;
    } else {
      output = text;
    }

    ptyProcess.write(output);
    log('voice: text sent to tab', tabId);
    if (withEnter) {
      ptyProcess.write('\r');
      log('voice: Enter sent to tab', tabId);
    }
  }

  // Right Option + Right Shift → new tab + record
  // Recording starts immediately; tab creation happens in parallel
  ipcMain.on('voice:new-tab-ready', (_e, tabId: string) => {
    log('voice: new tab ready:', tabId);
    recordingTabId = tabId;
    // Update the voice indicator to show on the correct tab
    setState(state);
  });

  // Key listeners
  uIOhook.on('keydown', (e) => {
    if (e.keycode === UiohookKey.AltRight) {
      rightOptionHeld = true;
    } else if (e.keycode === UiohookKey.ShiftRight) {
      if (state === 'idle') {
        if (rightOptionHeld) {
          // Start recording immediately, create tab in parallel
          startRecording();
          const win = getMainWindow();
          if (win && !win.isDestroyed()) {
            log('voice: requesting new tab for recording');
            win.webContents.send('voice:new-tab-record');
          }
        } else {
          startRecording();
        }
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

  uIOhook.on('keyup', (e) => {
    if (e.keycode === UiohookKey.AltRight) {
      rightOptionHeld = false;
    }
  });

  uIOhook.start();
  log('voice: uiohook started, listening for Right Shift / Right Option+Shift');

  return {
    stop() {
      uIOhook.stop();
      if (soxProc) { soxProc.kill('SIGTERM'); soxProc = null; }
  
      log('voice: stopped');
    },
  };
}
