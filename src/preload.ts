import { contextBridge, ipcRenderer } from 'electron';

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
});

contextBridge.exposeInMainWorld('voice', {
  onStateChange: (cb: (state: string, tabId: string | null) => void) => {
    const handler = (_: unknown, state: string, tabId: string | null) => cb(state, tabId);
    ipcRenderer.on('voice:state', handler);
    return () => ipcRenderer.removeListener('voice:state', handler);
  },
});
