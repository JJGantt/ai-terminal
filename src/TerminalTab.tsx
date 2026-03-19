import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface Props { id: string; active: boolean; resumeSessionId?: string; panelNav?: boolean; }

export default function TerminalTab({ id, active, resumeSessionId, panelNav }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const panelNavRef = useRef(panelNav);
  panelNavRef.current = panelNav;

  useEffect(() => {
    console.log('[TerminalTab] mounting', id);
    const term = new Terminal({
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      theme: { background: '#1e1e1e' },
      cursorBlink: true,
      scrollSensitivity: 3,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current!);
    termRef.current = term;
    fitRef.current = fit;

    term.attachCustomKeyEventHandler((e) => {
      if (!e.altKey && !e.ctrlKey && !e.metaKey) {
        // Bare left/right → always blocked (tab navigation in App.tsx)
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') return false;
        // Bare up/down → blocked during panel nav
        if (panelNavRef.current && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) return false;
      }
      return true;
    });

    // Track scroll position to detect unexpected jumps
    let lastViewportY = 0;
    let lastAltBufferActive = false;
    const scrollCheck = setInterval(() => {
      const y = term.buffer.active.viewportY;
      const alt = term.buffer.active === term.buffer.alternate;
      if (y !== lastViewportY || alt !== lastAltBufferActive) {
        if (lastViewportY > 5 && y === 0 && !alt) {
          console.log(`[scroll-debug] ${id} JUMP TO TOP: viewportY ${lastViewportY} → ${y}, alt=${alt}, baseY=${term.buffer.active.baseY}, cols=${term.cols} rows=${term.rows}`);
          console.trace('[scroll-debug] stack');
        }
        lastViewportY = y;
        lastAltBufferActive = alt;
      }
    }, 100);

    // Refit whenever the container size changes (window resize, panel toggle, etc.)
    const el = containerRef.current!;
    let lastW = el.clientWidth;
    let lastH = el.clientHeight;
    const ro = new ResizeObserver(() => {
      if (el.clientHeight > 0 && el.clientWidth > 0) {
        const w = el.clientWidth;
        const h = el.clientHeight;
        if (w !== lastW || h !== lastH) {
          console.log(`[scroll-debug] ${id} ResizeObserver: container ${lastW}x${lastH} → ${w}x${h}, term ${term.cols}x${term.rows}, viewportY=${term.buffer.active.viewportY}`);
          lastW = w;
          lastH = h;
        }
        fit.fit();
      }
    });
    ro.observe(el);

    let disposed = false;
    let cleanupData: (() => void) | null = null;

    window.pty.create(id, resumeSessionId).then(() => {
      if (disposed) {
        window.pty.kill(id);
        return;
      }
      console.log('[TerminalTab] pty created', id);
      cleanupData = window.pty.onData(id, data => term.write(data));
      term.onData(data => window.pty.write(id, data));
      term.onResize(({ cols, rows }) => {
        console.log(`[scroll-debug] ${id} onResize: ${term.cols}x${term.rows} → ${cols}x${rows}, viewportY=${term.buffer.active.viewportY}`);
        window.pty.resize(id, cols, rows);
      });
      fit.fit();
      window.pty.resize(id, term.cols, term.rows);
      console.log(`[TerminalTab] fit after PTY: cols=${term.cols} rows=${term.rows}`);
      window.pty.onExit(id, () => {
        console.log('[TerminalTab] pty exited', id);
        term.write('\r\n[session ended]\r\n');
      });
    }).catch(err => console.error('[TerminalTab] pty create failed', err));

    return () => {
      disposed = true;
      clearInterval(scrollCheck);
      ro.disconnect();
      cleanupData?.();
      window.pty.kill(id);
      term.dispose();
    };
  }, [id]);

  useEffect(() => {
    if (active) {
      setTimeout(() => {
        fitRef.current?.fit();
        termRef.current?.scrollToBottom();
      }, 0);
      termRef.current?.focus();
    }
  }, [active]);

  // Re-fit when window gains focus (reclaim dimensions from phone)
  useEffect(() => {
    if (!active) return;
    const cleanupRefit = window.app.onRefit(() => {
      fitRef.current?.fit();
    });
    // Also re-fit on click — covers alwaysOnTop windows that never lose focus
    const el = containerRef.current;
    const handleClick = () => fitRef.current?.fit();
    el?.addEventListener('click', handleClick);
    return () => {
      cleanupRefit();
      el?.removeEventListener('click', handleClick);
    };
  }, [active, id]);

  return (
    <div
      ref={containerRef}
      style={{ display: active ? 'flex' : 'none', flex: 1, padding: 4 }}
    />
  );
}
