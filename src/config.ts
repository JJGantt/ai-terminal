import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CONFIG_DIR = path.join(os.homedir(), '.ai-terminal');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

interface AppConfig {
  historyDir: string;
}

const DEFAULTS: AppConfig = {
  historyDir: path.join(CONFIG_DIR, 'history'),
};

export function loadConfig(): AppConfig {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  } catch { /* exists */ }

  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    // Expand ~ in paths
    const historyDir = (raw.historyDir || DEFAULTS.historyDir)
      .replace(/^~/, os.homedir());
    return { historyDir };
  } catch {
    // Write defaults on first run
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2));
    return { ...DEFAULTS };
  }
}
