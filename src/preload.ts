import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('pty', {
  create: (id: string) => ipcRenderer.invoke('pty:create', id),
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
});
