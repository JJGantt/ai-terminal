import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface Props { id: string; active: boolean; resumeSessionId?: string; }

export default function TerminalTab({ id, active, resumeSessionId }: Props) {
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
      scrollSensitivity: 3,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current!);
    termRef.current = term;
    fitRef.current = fit;

    // Bare left/right arrows → tab navigation (handled by App.tsx document listener)
    // Option+arrows → pass through to terminal as normal cursor movement
    term.attachCustomKeyEventHandler((e) => {
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.altKey && !e.ctrlKey && !e.metaKey) {
        return false; // don't let xterm process it
      }
      return true;
    });

    // Refit whenever the container size changes (window resize, panel toggle, etc.)
    const el = containerRef.current!;
    const ro = new ResizeObserver(() => {
      if (el.clientHeight > 0 && el.clientWidth > 0) {
        fit.fit();
      }
    });
    ro.observe(el);

    let cleanupData: (() => void) | null = null;

    window.pty.create(id, resumeSessionId).then(() => {
      console.log('[TerminalTab] pty created', id);
      let claudeStarted = false;
      cleanupData = window.pty.onData(id, data => {
        if (!claudeStarted && data.includes('Claude Code')) {
          claudeStarted = true;
          term.reset();
        }
        term.write(data);
      });
      term.onData(data => window.pty.write(id, data));
      term.onResize(({ cols, rows }) => {
        console.log(`[TerminalTab] onResize fired: ${cols}x${rows}`);
        window.pty.resize(id, cols, rows);
      });
      // Tell tmux the real terminal size
      fit.fit();
      window.pty.resize(id, term.cols, term.rows);
      console.log(`[TerminalTab] fit after PTY: cols=${term.cols} rows=${term.rows}`);
      window.pty.onExit(id, () => {
        console.log('[TerminalTab] pty exited', id);
        term.write('\r\n[session ended]\r\n');
      });
    }).catch(err => console.error('[TerminalTab] pty create failed', err));

    return () => {
      ro.disconnect();
      cleanupData?.();
      window.pty.kill(id);
      term.dispose();
    };
  }, [id]);

  useEffect(() => {
    if (active) {
      setTimeout(() => fitRef.current?.fit(), 0);
      termRef.current?.focus();
    }
  }, [active]);

  return (
    <div
      ref={containerRef}
      style={{ display: active ? 'flex' : 'none', flex: 1, padding: 4 }}
    />
  );
}
