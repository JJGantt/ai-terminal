import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface Props {
  id: string;
  active: boolean;
}

export default function TerminalTab({ id, active }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
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

    // Spawn PTY
    window.pty.create(id).then(() => {
      // Stream PTY output into terminal
      const cleanup = window.pty.onData(id, (data) => term.write(data));

      // Send terminal input to PTY
      term.onData((data) => window.pty.write(id, data));

      // Resize PTY when terminal resizes
      term.onResize(({ cols, rows }) => window.pty.resize(id, cols, rows));

      return cleanup;
    });

    return () => {
      window.pty.kill(id);
      term.dispose();
    };
  }, [id]);

  // Fit on visibility change
  useEffect(() => {
    if (active && fitRef.current) {
      setTimeout(() => fitRef.current?.fit(), 0);
    }
  }, [active]);

  // Fit on window resize
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
