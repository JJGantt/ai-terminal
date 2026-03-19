import { useState, useCallback, useEffect, useRef } from 'react';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, DragEndEvent } from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import TerminalTab from './TerminalTab';
import './App.css';

interface Tab { id: string; label: string; resumeSessionId?: string; host?: 'pi'; }



let counter = 1;
const makeTab = (): Tab => ({ id: crypto.randomUUID(), label: `Session ${counter++}` });

function SortableTab({ tab, isActive, isRenaming, renameValue, renameInputRef, voiceState, status, onSetActive, onContextMenu, onRenameChange, onCommitRename, onCancelRename, onClose }: {
  tab: Tab; isActive: boolean; isRenaming: boolean; renameValue: string;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  voiceState: string | null; status?: 'working' | 'done';
  onSetActive: () => void; onContextMenu: (e: React.MouseEvent) => void;
  onRenameChange: (v: string) => void; onCommitRename: () => void; onCancelRename: () => void;
  onClose: (e: React.MouseEvent) => void;
}) {
  const isPi = tab.host === 'pi';
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : undefined,
  };
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}
      className={`tab ${isActive ? 'active' : ''}`}
      onClick={onSetActive} onContextMenu={onContextMenu}>
      <button className="close-btn" onClick={onClose}>×</button>
      {isPi && <span className="pi-badge">π</span>}
      {isRenaming ? (
        <input ref={renameInputRef} className="tab-rename-input" value={renameValue}
          onChange={e => onRenameChange(e.target.value)} onBlur={onCommitRename}
          onKeyDown={e => { if (e.key === 'Enter') onCommitRename(); if (e.key === 'Escape') onCancelRename(); }}
          onClick={e => e.stopPropagation()} />
      ) : (
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tab.label}</span>
      )}
      {voiceState && <div className={`voice-dot ${voiceState}`} />}
      {status === 'working' && <span className="tab-spinner" />}
      {status === 'done' && <span className="tab-done-dot" />}
    </div>
  );
}

function formatDateHeader(dateStr: string): string {
  const date = new Date(dateStr + 'T12:00:00'); // noon to avoid timezone issues
  const today = new Date();
  const diffDays = Math.floor((today.getTime() - date.getTime()) / 86400000);
  if (diffDays <= 7) {
    return date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  }
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function timeAgo(mtime: number): string {
  const diff = Date.now() - mtime;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function App() {
  const [tabs, setTabs] = useState<Tab[]>(() => [makeTab()]);
  const [activeId, setActiveId] = useState<string>(() => tabs[0].id);
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  const [barMode, setBarMode] = useState(false);
  const [barLocked, setBarLocked] = useState(false);
  useEffect(() => { window.app.setBarMode(barMode); }, [barMode]);

  // Panel navigation state (must be before handleArrow)
  const [panelNav, setPanelNav] = useState(false);
  const [panelNavIdx, setPanelNavIdx] = useState(0);
  const panelNavRef = useRef(false);
  panelNavRef.current = panelNav;

  useEffect(() => { window.app.setPanelNav(panelNav); }, [panelNav]);

  const [panelOpen, setPanelOpen] = useState(true);
  const panelOpenRef = useRef(panelOpen);
  panelOpenRef.current = panelOpen;
  const [sessionsOpen, setSessionsOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [voiceAutoStop, setVoiceAutoStop] = useState(true);
  const [voiceAutoStopSeconds, setVoiceAutoStopSeconds] = useState(3.0);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const handleArrow = useCallback((direction: string) => {
    if (panelNavRef.current) {
      if (direction === 'up') {
        setPanelNavIdx(prev => Math.max(0, prev - 1));
      } else if (direction === 'down') {
        setPanelNavIdx(prev => Math.min(sessionsRef.current.length - 1, prev + 1));
      } else if (direction === 'left') {
        setPanelNav(false);
        setPanelOpen(false);
      } else if (direction === 'right') {
        setPanelNav(false);
      }
      return;
    }
    if (direction === 'left' || direction === 'right') {
      setTabs(prev => {
        const idx = prev.findIndex(t => t.id === activeIdRef.current);
        if (idx === -1) return prev;
        const next = direction === 'left' ? idx - 1 : idx + 1;
        if (next >= 0 && next < prev.length) {
          setActiveId(prev[next].id);
        } else if (direction === 'right' && idx === prev.length - 1) {
          const tab = makeTab();
          setActiveId(tab.id);
          return [...prev, tab];
        } else if (direction === 'left' && idx === 0) {
          setPanelOpen(true);
          setPanelNav(true);
          setPanelNavIdx(0);
        }
        return prev;
      });
    }
  }, []);

  // Listen for bar mode changes from main (keyspy Option+Up/Down)
  useEffect(() => {
    return window.app.onBarModeChanged(setBarMode);
  }, []);

  // Listen for bar lock state changes
  useEffect(() => {
    return window.app.onBarLockChanged(setBarLocked);
  }, []);

  // Listen for global arrow commands (when bar is locked via keyspy)
  useEffect(() => {
    return window.app.onArrow(handleArrow);
  }, [handleArrow]);

  useEffect(() => {
    window.pty.notifyActive(activeId);
    if (!barMode) {
      setTabStatus(prev => {
        if (!prev[activeId]) return prev;
        const next = { ...prev };
        delete next[activeId];
        return next;
      });
    }
  }, [activeId, barMode]);

  // Drag-and-drop files → paste path into active terminal
  useEffect(() => {
    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      const files = e.dataTransfer?.files;
      if (!files?.length) return;
      const paths = Array.from(files).map(f => window.files.getPath(f)).filter(Boolean);
      if (paths.length) {
        const escaped = paths.map(p => p.includes(' ') ? `'${p}'` : p).join(' ');
        window.pty.write(activeId, escaped);
      }
    };
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('drop', onDrop);
    return () => {
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('drop', onDrop);
    };
  }, [activeId]);

  // Bare left/right arrows switch tabs; Option+Up/Down controls bar mode (in-app)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) return;
      // Option+Up/Down → bar mode
      if (e.altKey && !e.shiftKey) {
        if (e.key === 'ArrowUp') { e.preventDefault(); setBarMode(true); return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); setBarMode(false); return; }
      }
      // Bare arrows → tab switching / panel nav
      if (e.altKey) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        handleArrow(e.key === 'ArrowLeft' ? 'left' : 'right');
      } else if (panelNavRef.current && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        handleArrow(e.key === 'ArrowUp' ? 'up' : 'down');
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [handleArrow]);

  const [piConnected, setPiConnected] = useState(false);

  const [voiceState, setVoiceState] = useState<string>('idle');
  const [voiceTabId, setVoiceTabId] = useState<string | null>(null);
  const [dateGroups, setDateGroups] = useState<string[]>([]);
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set());
  const [dateSessions, setDateSessions] = useState<Record<string, SessionInfo[]>>({});

  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Track which session IDs are open in tabs: sessionId → tabId
  const [openSessions, setOpenSessions] = useState<Record<string, string>>({});
  const [confirmHideId, setConfirmHideId] = useState<string | null>(null);
  const [tabStatus, setTabStatus] = useState<Record<string, 'working' | 'done'>>({});

  useEffect(() => {
    return window.pty.onRename((tabId, title) => {
      setTabs(prev => prev.map(t => t.id === tabId ? { ...t, label: title } : t));
    });
  }, []);

  // Right Option + Right Shift → create new tab and start recording in it
  useEffect(() => {
    return window.voice.onNewTabRecord(() => {
      const tab = makeTab();
      setTabs(prev => [...prev, tab]);
      setActiveId(tab.id);
      window.voice.newTabReady(tab.id);
    });
  }, []);


  useEffect(() => {
    return window.pty.onSessionMapped((tabId, sessionId) => {
      setOpenSessions(prev => ({ ...prev, [sessionId]: tabId }));
    });
  }, []);

  useEffect(() => {
    return window.pty.onStartRename((tabId) => {
      const tab = tabs.find(t => t.id === tabId);
      if (tab) {
        setRenamingTabId(tabId);
        setRenameValue(tab.label);
      }
    });
  }, [tabs]);

  useEffect(() => {
    const cleanupWorking = window.pty.onWorking((tabId) => {
      if (tabId === activeIdRef.current) return;
      setTabStatus(prev => prev[tabId] === 'working' ? prev : { ...prev, [tabId]: 'working' });
    });
    const cleanupBell = window.pty.onBell((tabId) => {
      if (tabId === activeIdRef.current) return;
      setTabStatus(prev => prev[tabId] === 'done' ? prev : { ...prev, [tabId]: 'done' });
    });
    return () => { cleanupWorking(); cleanupBell(); };
  }, []);

  useEffect(() => {
    return window.sessions.onConfirmHide(setConfirmHideId);
  }, []);

  useEffect(() => {
    return window.voice.onStateChange((state, tabId) => {
      setVoiceState(state);
      setVoiceTabId(tabId);
    });
  }, []);

  // Pi integration — sync Pi tabs into the main tab array
  useEffect(() => {
    return window.pi.onConnected(setPiConnected);
  }, []);

  useEffect(() => {
    return window.pi.onTabs((piTabs) => {
      setTabs(prev => {
        // Remove Pi tabs that no longer exist
        const piIds = new Set(piTabs.map(t => t.id));
        let next = prev.filter(t => !t.host || piIds.has(t.id));
        // Update existing Pi tabs and add new ones
        for (const pt of piTabs) {
          const idx = next.findIndex(t => t.id === pt.id);
          if (idx >= 0) {
            next = next.map(t => t.id === pt.id ? { ...t, label: pt.name } : t);
          } else {
            next = [...next, { id: pt.id, label: pt.name, host: 'pi' as const }];
          }
        }
        return next;
      });
      // Update working status for Pi tabs
      for (const pt of piTabs) {
        setTabStatus(prev => {
          if (pt.working && prev[pt.id] !== 'working') return { ...prev, [pt.id]: 'working' };
          if (!pt.working && prev[pt.id] === 'working') {
            const next = { ...prev };
            delete next[pt.id];
            return next;
          }
          return prev;
        });
      }
    });
  }, []);

  useEffect(() => {
    return window.pi.onTabCreated((tabId) => {
      // Auto-select new Pi tab
      setActiveId(tabId);
    });
  }, []);

  useEffect(() => {
    if (!panelOpen) return;
    // Load immediately, then refresh every 30s
    const refresh = () => {
      window.sessions.list().then(setSessions);
      window.sessions.dates().then(setDateGroups);
    };
    refresh();
    const interval = setInterval(refresh, 30_000);
    return () => clearInterval(interval);
  }, [panelOpen]);

  const toggleDate = useCallback((date: string) => {
    setExpandedDates(prev => {
      const next = new Set(prev);
      if (next.has(date)) {
        next.delete(date);
      } else {
        next.add(date);
        if (!dateSessions[date]) {
          window.sessions.list({ date }).then(s => {
            setDateSessions(prev2 => ({ ...prev2, [date]: s }));
          });
        }
      }
      return next;
    });
  }, [dateSessions]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const onDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setTabs(prev => {
        const oldIdx = prev.findIndex(t => t.id === active.id);
        const newIdx = prev.findIndex(t => t.id === over.id);
        const arr = [...prev];
        const [moved] = arr.splice(oldIdx, 1);
        arr.splice(newIdx, 0, moved);
        return arr;
      });
    }
  }, []);

  useEffect(() => {
    if (renamingTabId) renameInputRef.current?.focus();
  }, [renamingTabId]);

  const commitRename = useCallback(() => {
    if (renamingTabId && renameValue.trim()) {
      window.pty.setName(renamingTabId, renameValue.trim());
      setTabs(prev => prev.map(t => t.id === renamingTabId ? { ...t, label: renameValue.trim() } : t));
    }
    setRenamingTabId(null);
  }, [renamingTabId, renameValue]);

  const addTab = useCallback(() => {
    const tab = makeTab();
    setTabs(prev => [...prev, tab]);
    setActiveId(tab.id);
  }, []);

  const resumeSession = useCallback((session: SessionInfo) => {
    // If already open, just switch to that tab
    const existingTabId = openSessions[session.id];
    if (existingTabId) {
      setActiveId(existingTabId);
    } else {
      const tab: Tab = {
        id: crypto.randomUUID(),
        label: session.title.slice(0, 30),
        resumeSessionId: session.id,
      };
      setTabs(prev => [...prev, tab]);
      setActiveId(tab.id);
    }
    setPanelOpen(false);
  }, [openSessions]);

  const handlePanelEnter = useCallback(() => {
    if (!panelNavRef.current) return;
    const session = sessionsRef.current[panelNavIdx];
    if (session) {
      resumeSession(session);
      setPanelNav(false);
    }
  }, [panelNavIdx, resumeSession]);

  // Option+Enter opens selected session in panel nav mode (in-app)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        handlePanelEnter();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [handlePanelEnter]);

  // Option+Enter via keyspy (global, when bar locked)
  useEffect(() => {
    return window.app.onEnter(handlePanelEnter);
  }, [handlePanelEnter]);

  const confirmHide = useCallback(async () => {
    if (!confirmHideId) return;
    await window.sessions.hide(confirmHideId);
    setConfirmHideId(null);
    // Refresh session lists
    window.sessions.list().then(setSessions);
    // Refresh any expanded date groups
    for (const date of expandedDates) {
      window.sessions.list({ date }).then(s => {
        setDateSessions(prev => ({ ...prev, [date]: s }));
      });
    }
  }, [confirmHideId, expandedDates]);

  const closeTab = useCallback((id: string) => {
    // Remove from open sessions tracking
    setOpenSessions(prev => {
      const next = { ...prev };
      for (const [sid, tid] of Object.entries(next)) {
        if (tid === id) { delete next[sid]; break; }
      }
      return next;
    });
    setTabs(prev => {
      const idx = prev.findIndex(t => t.id === id);
      const next = prev.filter(t => t.id !== id);
      if (next.length === 0) {
        const tab = makeTab();
        setActiveId(tab.id);
        return [tab];
      }
      if (activeId === id) {
        setActiveId(next[Math.min(idx, next.length - 1)].id);
      }
      return next;
    });
  }, [activeId]);

  // Option+Slash closes the active tab (via keyspy)
  useEffect(() => {
    return window.app.onCloseTab(() => closeTab(activeIdRef.current));
  }, [closeTab]);

  // Tab killed externally (e.g. phone closed it via WebSocket)
  useEffect(() => {
    return window.pty.onKilled((tabId) => {
      console.log('[App] tab:killed received for', tabId);
      closeTab(tabId);
    });
  }, [closeTab]);

  return (
    <div className="app">
      <div className={`tab-bar ${barMode ? 'bar-mode' : ''}`}>
        <span className={`bar-lock-indicator ${barLocked ? 'active' : ''}`} onClick={() => window.app.toggleBarLock()}>◆</span>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={tabs.map(t => t.id)} strategy={horizontalListSortingStrategy}>
            <div className="tabs">
              {tabs.map(tab => (
                <SortableTab key={tab.id} tab={tab} isActive={tab.id === activeId}
                  isRenaming={renamingTabId === tab.id} renameValue={renameValue} renameInputRef={renameInputRef}
                  voiceState={voiceTabId === tab.id && voiceState !== 'idle' ? voiceState : null}
                  status={tabStatus[tab.id]}
                  onSetActive={() => { if (tab.id === activeId) { setBarMode(!barMode); } else { setActiveId(tab.id); setBarMode(false); } }}
                  onContextMenu={e => { e.preventDefault(); window.pty.contextMenu(tab.id); }}
                  onRenameChange={setRenameValue} onCommitRename={commitRename}
                  onCancelRename={() => setRenamingTabId(null)}
                  onClose={e => { e.stopPropagation(); closeTab(tab.id); }} />
              ))}
            </div>
          </SortableContext>
        </DndContext>
        <button className="new-tab-btn" onClick={addTab} title="New session">+</button>
        <button className="new-tab-btn pi-new-tab" onClick={() => window.pi.newTab()} title="New Pi session"
          style={{ opacity: piConnected ? 1 : 0.3, pointerEvents: piConnected ? 'auto' : 'none' }}>π+</button>
      </div>
      <div className="main-content" style={{ display: barMode ? 'none' : undefined }}>
        <div className={`left-panel ${panelOpen ? 'open' : 'collapsed'}`}>
          <div className="panel-content">
            <div className="panel-header panel-section-toggle" onClick={() => setSessionsOpen(o => !o)}>
              <span className="panel-title">Sessions</span>
              <span className="panel-caret">{sessionsOpen ? '▾' : '▸'}</span>
            </div>
            {sessionsOpen && (
              <div className="session-list">
                {sessions.map((s, i) => (
                  <div key={s.id} className={`session-item ${openSessions[s.id] ? 'open' : ''} ${panelNav && i === panelNavIdx ? 'nav-selected' : ''}`}
                    onClick={() => resumeSession(s)}
                    onContextMenu={e => { e.preventDefault(); window.sessions.contextMenu(s.id); }}>
                    <div className="session-title">{s.title}</div>
                    <div className="session-time">{timeAgo(s.mtime)}</div>
                  </div>
                ))}
                {dateGroups
                  .filter(d => d < new Date(Date.now() - 86400000).toISOString().slice(0, 10))
                  .slice(0, 30)
                  .map(date => (
                    <div key={date}>
                      <div className="date-header" onClick={() => toggleDate(date)}>
                        <span>{expandedDates.has(date) ? '▾' : '▸'}</span>
                        <span>{formatDateHeader(date)}</span>
                      </div>
                      {expandedDates.has(date) && dateSessions[date]?.map(s => (
                        <div key={s.id} className={`session-item ${openSessions[s.id] ? 'open' : ''}`} onClick={() => resumeSession(s)}>
                          <div className="session-title">{s.title}</div>
                          <div className="session-time">{timeAgo(s.mtime)}</div>
                        </div>
                      ))}
                    </div>
                  ))}
              </div>
            )}
            <div className="panel-section-toggle settings-header" onClick={() => {
              const opening = !settingsOpen;
              setSettingsOpen(opening);
              if (opening) {
                window.config.get().then(cfg => {
                  setVoiceAutoStop(cfg.voiceAutoStop);
                  setVoiceAutoStopSeconds(cfg.voiceAutoStopSeconds);
                });
              }
            }}>
              <span className="panel-title">Settings</span>
              <span className="panel-caret">{settingsOpen ? '▾' : '▸'}</span>
            </div>
            {settingsOpen && (
              <div className="panel-settings">
                <div className="settings-group-label">Usage</div>
                <button className="settings-cmd-btn" onClick={() => window.pty.write(activeIdRef.current!, '\x1b/usage\r')}>
                  Check Usage
                </button>
                <div className="settings-group-label">Model</div>
                {(['opus', 'sonnet', 'haiku'] as const).map(alias => (
                  <button key={alias} className="settings-cmd-btn" onClick={() => window.pty.write(activeIdRef.current!, `\x1b/model ${alias}\r`)}>
                    {alias.charAt(0).toUpperCase() + alias.slice(1)}
                  </button>
                ))}
                <button className="settings-cmd-btn" style={{ color: '#666', fontSize: '11px' }} onClick={() => window.pty.write(activeIdRef.current!, '\x1b/model\r')}>
                  Browse all…
                </button>
                <div className="settings-group-label">Voice</div>
                <label className="settings-toggle">
                  <input type="checkbox" checked={voiceAutoStop} onChange={e => {
                    setVoiceAutoStop(e.target.checked);
                    window.config.set({ voiceAutoStop: e.target.checked });
                  }} />
                  Auto-stop on silence
                </label>
                {voiceAutoStop && (
                  <label className="settings-range">
                    <span>Silence: {voiceAutoStopSeconds.toFixed(1)}s</span>
                    <input type="range" min="1" max="6" step="0.5" value={voiceAutoStopSeconds} onChange={e => {
                      const v = parseFloat(e.target.value);
                      setVoiceAutoStopSeconds(v);
                      window.config.set({ voiceAutoStopSeconds: v });
                    }} />
                  </label>
                )}
              </div>
            )}
          </div>
          <button className="panel-close-rail" onClick={() => setPanelOpen(false)}>‹</button>
        </div>
        {!panelOpen && (
          <button className="panel-expand" onClick={() => setPanelOpen(true)}>›</button>
        )}
        <div className="terminal-area">
          {tabs.map(tab => (
            <TerminalTab key={tab.id} id={tab.id} active={tab.id === activeId} resumeSessionId={tab.resumeSessionId} panelNav={panelNav} />
          ))}
        </div>
      </div>
      {confirmHideId && (
        <div className="modal-overlay" onClick={() => setConfirmHideId(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <p>Hide this session from the sidebar?</p>
            <div className="modal-buttons">
              <button className="modal-btn cancel" onClick={() => setConfirmHideId(null)}>Cancel</button>
              <button className="modal-btn confirm" onClick={confirmHide}>Hide</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
