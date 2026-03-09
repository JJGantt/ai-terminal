import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('sessions', {
  list: (opts?: { since?: number; date?: string }) => ipcRenderer.invoke('sessions:list', opts),
  dates: () => ipcRenderer.invoke('sessions:dates'),
  hide: (sessionId: string) => ipcRenderer.invoke('sessions:hide', sessionId),
  contextMenu: (sessionId: string) => ipcRenderer.send('session:context-menu', sessionId),
  onConfirmHide: (cb: (sessionId: string) => void) => {
    const handler = (_: unknown, sessionId: string) => cb(sessionId);
    ipcRenderer.on('session:confirm-hide', handler);
    return () => ipcRenderer.removeListener('session:confirm-hide', handler);
  },
});

contextBridge.exposeInMainWorld('pty', {
  create: (id: string, resumeSessionId?: string) => ipcRenderer.invoke('pty:create', id, resumeSessionId),
  write: (id: string, data: string) => ipcRenderer.send('pty:write', id, data),
  resize: (id: string, cols: number, rows: number) => ipcRenderer.send('pty:resize', id, cols, rows),
  kill: (id: string) => ipcRenderer.send('pty:kill', id),
  onData: (id: string, cb: (data: string) => void) => {
    const handler = (_: unknown, data: string) => cb(data);
    ipcRenderer.on(`pty:data:${id}`, handler);
    return () => ipcRenderer.removeListener(`pty:data:${id}`, handler);
  },
  onExit: (id: string, cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.once(`pty:exit:${id}`, handler);
    return () => ipcRenderer.removeListener(`pty:exit:${id}`, handler);
  },
  notifyActive: (id: string) => ipcRenderer.send('tab:active', id),
  onRename: (cb: (tabId: string, title: string) => void) => {
    const handler = (_: unknown, tabId: string, title: string) => cb(tabId, title);
    ipcRenderer.on('tab:rename', handler);
    return () => ipcRenderer.removeListener('tab:rename', handler);
  },
  contextMenu: (id: string) => ipcRenderer.send('tab:context-menu', id),
  setName: (id: string, name: string) => ipcRenderer.send('tab:set-name', id, name),
  onStartRename: (cb: (tabId: string) => void) => {
    const handler = (_: unknown, tabId: string) => cb(tabId);
    ipcRenderer.on('tab:start-rename', handler);
    return () => ipcRenderer.removeListener('tab:start-rename', handler);
  },
  onSessionMapped: (cb: (tabId: string, sessionId: string) => void) => {
    const handler = (_: unknown, tabId: string, sessionId: string) => cb(tabId, sessionId);
    ipcRenderer.on('tab:session-mapped', handler);
    return () => ipcRenderer.removeListener('tab:session-mapped', handler);
  },
  onBell: (cb: (tabId: string) => void) => {
    const handler = (_: unknown, tabId: string) => cb(tabId);
    ipcRenderer.on('tab:bell', handler);
    return () => ipcRenderer.removeListener('tab:bell', handler);
  },
  onWorking: (cb: (tabId: string) => void) => {
    const handler = (_: unknown, tabId: string) => cb(tabId);
    ipcRenderer.on('tab:working', handler);
    return () => ipcRenderer.removeListener('tab:working', handler);
  },
});

contextBridge.exposeInMainWorld('app', {
  setBarMode: (enabled: boolean) => ipcRenderer.send('app:bar-mode', enabled),
  setPanelNav: (active: boolean) => ipcRenderer.send('app:panel-nav', active),
  toggleBarLock: () => ipcRenderer.send('app:toggle-bar-lock'),
  onArrow: (cb: (direction: string) => void) => {
    const handler = (_: unknown, direction: string) => cb(direction);
    ipcRenderer.on('app:arrow', handler);
    return () => ipcRenderer.removeListener('app:arrow', handler);
  },
  onBarModeChanged: (cb: (enabled: boolean) => void) => {
    const handler = (_: unknown, enabled: boolean) => cb(enabled);
    ipcRenderer.on('app:bar-mode-changed', handler);
    return () => ipcRenderer.removeListener('app:bar-mode-changed', handler);
  },
  onBarLockChanged: (cb: (locked: boolean) => void) => {
    const handler = (_: unknown, locked: boolean) => cb(locked);
    ipcRenderer.on('app:bar-lock', handler);
    return () => ipcRenderer.removeListener('app:bar-lock', handler);
  },
  onCloseTab: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('app:close-tab', handler);
    return () => ipcRenderer.removeListener('app:close-tab', handler);
  },
  onEnter: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('app:enter', handler);
    return () => ipcRenderer.removeListener('app:enter', handler);
  },
});

contextBridge.exposeInMainWorld('pi', {
  onTabs: (cb: (tabs: { id: string; name: string; working: boolean }[]) => void) => {
    const handler = (_: unknown, tabs: { id: string; name: string; working: boolean }[]) => cb(tabs);
    ipcRenderer.on('pi:tabs', handler);
    return () => ipcRenderer.removeListener('pi:tabs', handler);
  },
  onConnected: (cb: (connected: boolean) => void) => {
    const handler = (_: unknown, connected: boolean) => cb(connected);
    ipcRenderer.on('pi:connected', handler);
    return () => ipcRenderer.removeListener('pi:connected', handler);
  },
  onTabCreated: (cb: (tabId: string) => void) => {
    const handler = (_: unknown, tabId: string) => cb(tabId);
    ipcRenderer.on('pi:tab-created', handler);
    return () => ipcRenderer.removeListener('pi:tab-created', handler);
  },
  newTab: () => ipcRenderer.send('pi:new-tab'),
  resumeTab: (sessionId: string) => ipcRenderer.send('pi:resume-tab', sessionId),
});

contextBridge.exposeInMainWorld('files', {
  getPath: (file: File) => webUtils.getPathForFile(file),
});

contextBridge.exposeInMainWorld('voice', {
  onStateChange: (cb: (state: string, tabId: string | null) => void) => {
    const handler = (_: unknown, state: string, tabId: string | null) => cb(state, tabId);
    ipcRenderer.on('voice:state', handler);
    return () => ipcRenderer.removeListener('voice:state', handler);
  },
  onNewTabRecord: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('voice:new-tab-record', handler);
    return () => ipcRenderer.removeListener('voice:new-tab-record', handler);
  },
  newTabReady: (tabId: string) => ipcRenderer.send('voice:new-tab-ready', tabId),
});
