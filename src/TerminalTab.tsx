import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface Props { id: string; active: boolean; resumeSessionId?: string; panelNav?: boolean; }

interface TranscriptMsg { role: string; text: string; }

export default function TerminalTab({ id, active, resumeSessionId, panelNav }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const panelNavRef = useRef(panelNav);
  panelNavRef.current = panelNav;

  const [transcriptMode, setTranscriptMode] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptMsg[]>([]);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef(true);

  // Main terminal setup
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
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') return false;
        if (panelNavRef.current && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) return false;
      }
      return true;
    });

    const el = containerRef.current!;
    let lastW = el.clientWidth;
    let lastH = el.clientHeight;
    const ro = new ResizeObserver(() => {
      if (el.clientHeight > 0 && el.clientWidth > 0) {
        const w = el.clientWidth;
        const h = el.clientHeight;
        if (w !== lastW || h !== lastH) { lastW = w; lastH = h; }
        fit.fit();
      }
    });
    ro.observe(el);

    let disposed = false;
    let cleanupData: (() => void) | null = null;

    window.pty.create(id, resumeSessionId).then(() => {
      if (disposed) { window.pty.kill(id); return; }
      cleanupData = window.pty.onData(id, data => term.write(data));
      term.onData(data => window.pty.write(id, data));
      term.onResize(({ cols, rows }) => { window.pty.resize(id, cols, rows); });
      fit.fit();
      window.pty.resize(id, term.cols, term.rows);
      window.pty.onExit(id, () => { term.write('\r\n[session ended]\r\n'); });
    }).catch(err => console.error('[TerminalTab] pty create failed', err));

    return () => {
      disposed = true;
      ro.disconnect();
      cleanupData?.();
      window.pty.kill(id);
      term.dispose();
    };
  }, [id]);

  // Focus + fit on tab activation
  useEffect(() => {
    if (active) {
      setTimeout(() => {
        fitRef.current?.fit();
        termRef.current?.scrollToBottom();
      }, 0);
      termRef.current?.focus();
    }
  }, [active]);

  // Force resize on click (reclaim from phone)
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
    return () => { cleanupRefit(); el?.removeEventListener('click', forceRefit); };
  }, [active, id]);

  // Transcript mode: load + subscribe to updates
  useEffect(() => {
    if (!transcriptMode || !active) return;

    window.pty.getTranscript(id).then(msgs => setTranscript(msgs));
    window.pty.subscribeTranscript(id);
    const cleanup = window.pty.onTranscriptData(id, msgs => setTranscript(msgs));

    return () => { window.pty.unsubscribeTranscript(id); cleanup(); };
  }, [transcriptMode, active, id]);

  // Auto-scroll transcript when new messages arrive (if user is at bottom)
  useEffect(() => {
    if (transcriptMode && wasAtBottomRef.current) {
      transcriptEndRef.current?.scrollIntoView({ behavior: 'auto' });
    }
  }, [transcript, transcriptMode]);

  // Track scroll position in transcript
  const handleTranscriptScroll = () => {
    const el = transcriptScrollRef.current;
    if (!el) return;
    wasAtBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
  };

  return (
    <div
      style={{ display: active ? 'flex' : 'none', flex: 1, position: 'relative', padding: 4 }}
      onDoubleClick={() => setTranscriptMode(m => !m)}
    >
      <div ref={containerRef} style={{ flex: 1, display: transcriptMode ? 'none' : 'flex' }} />

      {transcriptMode && (
        <div
          ref={transcriptScrollRef}
          onScroll={handleTranscriptScroll}
          style={{
            flex: 1, overflowY: 'auto', padding: '12px 16px',
            fontFamily: 'Menlo, Monaco, monospace', fontSize: 13,
            background: '#111', color: '#ccc',
          }}
        >
          {transcript.length === 0 && (
            <div style={{ color: '#555', fontStyle: 'italic' }}>Waiting for session data...</div>
          )}
          {transcript.map((msg, i) => (
            <div key={i} style={{
              padding: '8px 0',
              borderBottom: '1px solid #222',
              color: msg.role === 'user' ? '#fff' : '#aaa',
              background: msg.role === 'user' ? '#1a1a1a' : 'transparent',
              margin: msg.role === 'user' ? '4px -16px' : 0,
              padding: msg.role === 'user' ? '8px 16px' : '8px 0',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}>
              {msg.text}
            </div>
          ))}
          <div ref={transcriptEndRef} />
        </div>
      )}
    </div>
  );
}
