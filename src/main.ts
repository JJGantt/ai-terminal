import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import started from 'electron-squirrel-startup';
import pty from 'node-pty';

if (started) app.quit();

const log = (...args: unknown[]) => {
  const line = `[main] ${args.join(' ')}\n`;
  process.stdout.write(line);
  fs.appendFileSync('/tmp/ai-terminal.log', line);
};

const sessions = new Map<string, ReturnType<typeof pty.spawn>>();

ipcMain.handle('pty:create', (event, id: string) => {
  log('creating pty session:', id);
  const env = { ...process.env };
  // Strip Claude/Electron vars that would prevent nested claude from launching
  delete env.CLAUDECODE;
  delete env.CLAUDE_SESSION_ID;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;

  const ptyProcess = pty.spawn(process.env.SHELL || '/bin/zsh', ['--login'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: path.join(os.homedir(), 'workspace'),
    env,
  });
  // Give the shell a moment to initialize, then launch claude
  setTimeout(() => ptyProcess.write('claude --dangerously-skip-permissions\r'), 500);
  sessions.set(id, ptyProcess);
  ptyProcess.onData((data) => event.sender.send(`pty:data:${id}`, data));
  ptyProcess.onExit(({ exitCode, signal }) => {
    log(`pty exited: ${id} exitCode=${exitCode} signal=${signal}`);
    sessions.delete(id);
    event.sender.send(`pty:exit:${id}`);
  });
  return id;
});

ipcMain.on('pty:write', (_e, id: string, data: string) => sessions.get(id)?.write(data));
ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => sessions.get(id)?.resize(cols, rows));
ipcMain.on('pty:kill', (_e, id: string) => {
  log('pty:kill called for', id);
  sessions.get(id)?.kill();
  sessions.delete(id);
});

app.on('ready', () => {
  log('app ready');
  fs.writeFileSync('/tmp/ai-terminal.log', ''); // fresh log on each start

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.webContents.on('did-finish-load', () => log('renderer loaded'));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => log('FAILED', url, code, desc));
  win.webContents.on('console-message', (_e, _level, msg) => log('[renderer]', msg));

  const url = MAIN_WINDOW_VITE_DEV_SERVER_URL;
  log('vite url:', url);

  const tryLoad = (attempts = 0) => {
    (url ? win.loadURL(url) : win.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)))
      .catch((err) => {
        log(`load attempt ${attempts} failed: ${err.message}`);
        if (attempts < 20) setTimeout(() => tryLoad(attempts + 1), 500);
      });
  };
  tryLoad();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) app.emit('ready'); });
