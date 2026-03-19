import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CONFIG_DIR = path.join(os.homedir(), '.ai-terminal');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

export interface AppConfig {
  historyDir: string;
  voiceAutoStop: boolean;
  voiceAutoStopSeconds: number;
}

const DEFAULTS: AppConfig = {
  historyDir: path.join(CONFIG_DIR, 'history'),
  voiceAutoStop: true,
  voiceAutoStopSeconds: 3.0,
};

export function saveConfig(partial: Partial<AppConfig>) {
  const current = loadConfig();
  const merged = { ...current, ...partial };
  // Convert historyDir back to ~ form for storage
  const homedir = os.homedir();
  const stored = {
    ...merged,
    historyDir: merged.historyDir.startsWith(homedir)
      ? '~' + merged.historyDir.slice(homedir.length)
      : merged.historyDir,
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(stored, null, 2));
}

export function loadConfig(): AppConfig {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  } catch { /* exists */ }

  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    const historyDir = (raw.historyDir || DEFAULTS.historyDir)
      .replace(/^~/, os.homedir());
    return {
      historyDir,
      voiceAutoStop: raw.voiceAutoStop ?? DEFAULTS.voiceAutoStop,
      voiceAutoStopSeconds: raw.voiceAutoStopSeconds ?? DEFAULTS.voiceAutoStopSeconds,
    };
  } catch {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2));
    return { ...DEFAULTS };
  }
}
