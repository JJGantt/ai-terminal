import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface Props { id: string; active: boolean; }

export default function TerminalTab({ id, active }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    console.log('[TerminalTab] mounting', id);
    const term = new Terminal({
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      theme: { background: '#1e1e1e' },
      cursorBlink: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current!);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    let cleanupData: (() => void) | null = null;

    window.pty.create(id).then(() => {
      console.log('[TerminalTab] pty created', id);
      cleanupData = window.pty.onData(id, data => term.write(data));
      term.onData(data => window.pty.write(id, data));
      term.onResize(({ cols, rows }) => window.pty.resize(id, cols, rows));
      window.pty.onExit(id, () => {
        console.log('[TerminalTab] pty exited', id);
        term.write('\r\n[session ended]\r\n');
      });
    }).catch(err => console.error('[TerminalTab] pty create failed', err));

    return () => {
      cleanupData?.();
      window.pty.kill(id);
      term.dispose();
    };
  }, [id]);

  useEffect(() => {
    if (active) setTimeout(() => fitRef.current?.fit(), 0);
  }, [active]);

  useEffect(() => {
    const onResize = () => { if (active) fitRef.current?.fit(); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [active]);

  return (
    <div
      ref={containerRef}
      style={{ display: active ? 'flex' : 'none', flex: 1, padding: 4 }}
    />
  );
}
