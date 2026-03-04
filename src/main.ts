import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import started from 'electron-squirrel-startup';

if (started) app.quit();

const log = (...args: unknown[]) => {
  const line = `[main] ${args.join(' ')}\n`;
  process.stdout.write(line);
  fs.appendFileSync('/tmp/ai-terminal.log', line);
};

app.on('ready', () => {
  log('app ready');

  const win = new BrowserWindow({ width: 800, height: 600 });

  win.webContents.on('did-start-loading', () => log('started loading'));
  win.webContents.on('did-finish-load', () => log('finished loading'));
  win.webContents.on('did-fail-load', (_e, code, desc, url) =>
    log('FAILED to load', url, code, desc)
  );

  const url = MAIN_WINDOW_VITE_DEV_SERVER_URL;
  log('VITE URL:', url);

  if (url) {
    const tryLoad = (attempts = 0) => {
      win.loadURL(url).catch((err) => {
        log(`load attempt ${attempts} failed: ${err.message}`);
        if (attempts < 20) setTimeout(() => tryLoad(attempts + 1), 500);
      });
    };
    tryLoad();
  } else {
    win.loadFile(`../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`);
  }
});
