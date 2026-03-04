// Injected by electron-forge vite plugin at build time
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

interface Window {
  pty: {
    create: (id: string) => Promise<string>;
    write: (id: string, data: string) => void;
    resize: (id: string, cols: number, rows: number) => void;
    kill: (id: string) => void;
    onData: (id: string, cb: (data: string) => void) => () => void;
    onExit: (id: string, cb: () => void) => () => void;
  };
}
