import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface Props { id: string; active: boolean; resumeSessionId?: string; panelNav?: boolean; }

export default function TerminalTab({ id, active, resumeSessionId, panelNav }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const frozenContainerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const panelNavRef = useRef(panelNav);
  panelNavRef.current = panelNav;

  const [scrollLock, setScrollLock] = useState(false);
  const frozenTermRef = useRef<Terminal | null>(null);
  const frozenFitRef = useRef<FitAddon | null>(null);

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
  // Must force-send resize even if xterm thinks dimensions haven't changed,
  // because the PTY may have been resized externally by the phone.
  useEffect(() => {
    if (!active) return;
    const forceRefit = () => {
      fitRef.current?.fit();
      const term = termRef.current;
      if (term && term.cols > 0 && term.rows > 0) {
        window.pty.resize(id, term.cols, term.rows);
      }
    };
    const cleanupRefit = window.app.onRefit(forceRefit);
    const el = containerRef.current;
    el?.addEventListener('click', forceRefit);
    return () => {
      cleanupRefit();
      el?.removeEventListener('click', forceRefit);
    };
  }, [active, id]);

  // Enter scroll lock via Cmd+Shift+S
  useEffect(() => {
    if (!active) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.shiftKey && e.key === 's') {
        e.preventDefault();
        const term = termRef.current;
        if (term && term.buffer.active === term.buffer.alternate) {
          setScrollLock(true);
        }
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [active]);

  // Create/destroy frozen terminal when scroll lock toggles
  useEffect(() => {
    if (!scrollLock || !frozenContainerRef.current) return;

    const frozenTerm = new Terminal({
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      theme: { background: '#1a1a2e' },
      cursorBlink: false,
      scrollSensitivity: 3,
      scrollback: 50000,
      disableStdin: true,
    });
    const frozenFit = new FitAddon();
    frozenTerm.loadAddon(frozenFit);
    frozenTerm.open(frozenContainerRef.current);
    frozenTermRef.current = frozenTerm;
    frozenFitRef.current = frozenFit;
    frozenFit.fit();

    // Load stripped scrollback
    window.pty.getStrippedScrollback(id).then((data: string) => {
      frozenTerm.write(data);
      // Scroll to bottom initially so user can scroll up from there
      setTimeout(() => frozenTerm.scrollToBottom(), 50);
    });

    // Escape exits scroll lock
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setScrollLock(false);
    };
    window.addEventListener('keydown', handleKey);

    return () => {
      window.removeEventListener('keydown', handleKey);
      frozenTerm.dispose();
      frozenTermRef.current = null;
      frozenFitRef.current = null;
    };
  }, [scrollLock, id]);

  const exitScrollLock = useCallback(() => setScrollLock(false), []);

  return (
    <div style={{ display: active ? 'flex' : 'none', flex: 1, position: 'relative', padding: 4 }}>
      <div
        ref={containerRef}
        style={{ flex: 1, display: scrollLock ? 'none' : 'flex' }}
      />
      {scrollLock && (
        <>
          <div
            ref={frozenContainerRef}
            style={{ flex: 1, display: 'flex' }}
          />
          <button
            onClick={exitScrollLock}
            style={{
              position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)',
              zIndex: 10, padding: '10px 28px', borderRadius: 24, border: 'none',
              background: 'rgba(74, 158, 255, 0.9)', color: '#fff',
              fontSize: 14, fontWeight: 700, cursor: 'pointer',
              boxShadow: '0 2px 12px rgba(74, 158, 255, 0.4)',
            }}
          >
            Resume Live (Esc)
          </button>
        </>
      )}
    </div>
  );
}
