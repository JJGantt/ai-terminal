// Injected by electron-forge vite plugin at build time
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

interface SessionInfo {
  id: string;
  title: string;
  timestamp: string;
  mtime: number;
  project: string;
  source?: string;
}

interface Window {
  sessions: {
    list: (opts?: { since?: number; date?: string }) => Promise<SessionInfo[]>;
    dates: () => Promise<string[]>;
    hide: (sessionId: string) => Promise<boolean>;
    contextMenu: (sessionId: string) => void;
    onConfirmHide: (cb: (sessionId: string) => void) => () => void;
  };
  pty: {
    create: (id: string, resumeSessionId?: string) => Promise<string>;
    write: (id: string, data: string) => void;
    resize: (id: string, cols: number, rows: number) => void;
    kill: (id: string) => void;
    onData: (id: string, cb: (data: string) => void) => () => void;
    onExit: (id: string, cb: () => void) => () => void;
    notifyActive: (id: string) => void;
    onRename: (cb: (tabId: string, title: string) => void) => () => void;
    contextMenu: (id: string) => void;
    setName: (id: string, name: string) => void;
    onStartRename: (cb: (tabId: string) => void) => () => void;
    onSessionMapped: (cb: (tabId: string, sessionId: string) => void) => () => void;
    onBell: (cb: (tabId: string) => void) => () => void;
    onWorking: (cb: (tabId: string) => void) => () => void;
    onKilled: (cb: (tabId: string) => void) => () => void;
  };
  config: {
    get: () => Promise<{ historyDir: string; voiceAutoStop: boolean; voiceAutoStopSeconds: number }>;
    set: (partial: Record<string, unknown>) => void;
  };
  app: {
    setBarMode: (enabled: boolean) => void;
    setPanelNav: (active: boolean) => void;
    toggleBarLock: () => void;
    onArrow: (cb: (direction: string) => void) => () => void;
    onBarModeChanged: (cb: (enabled: boolean) => void) => () => void;
    onBarLockChanged: (cb: (locked: boolean) => void) => () => void;
    onCloseTab: (cb: () => void) => () => void;
    onEnter: (cb: () => void) => () => void;
    onRefit: (cb: () => void) => () => void;
  };
  pi: {
    onTabs: (cb: (tabs: { id: string; name: string; working: boolean }[]) => void) => () => void;
    onConnected: (cb: (connected: boolean) => void) => () => void;
    onTabCreated: (cb: (tabId: string) => void) => () => void;
    newTab: () => void;
    resumeTab: (sessionId: string) => void;
  };
  files: {
    getPath: (file: File) => string;
  };
  voice: {
    onStateChange: (cb: (state: string, tabId: string | null) => void) => () => void;
    onNewTabRecord: (cb: () => void) => () => void;
    newTabReady: (tabId: string) => void;
  };
}
