import { useState, useCallback, useEffect, useRef } from 'react';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, DragEndEvent } from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import TerminalTab from './TerminalTab';
import './App.css';

interface Tab { id: string; label: string; resumeSessionId?: string; }

let counter = 1;
const makeTab = (): Tab => ({ id: crypto.randomUUID(), label: `Session ${counter++}` });

function SortableTab({ tab, isActive, isRenaming, renameValue, renameInputRef, voiceState, onSetActive, onContextMenu, onRenameChange, onCommitRename, onCancelRename, onClose }: {
  tab: Tab; isActive: boolean; isRenaming: boolean; renameValue: string;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  voiceState: string | null;
  onSetActive: () => void; onContextMenu: (e: React.MouseEvent) => void;
  onRenameChange: (v: string) => void; onCommitRename: () => void; onCancelRename: () => void;
  onClose: (e: React.MouseEvent) => void;
}) {
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
      {voiceState && <div className={`voice-dot ${voiceState}`} />}
      {isRenaming ? (
        <input ref={renameInputRef} className="tab-rename-input" value={renameValue}
          onChange={e => onRenameChange(e.target.value)} onBlur={onCommitRename}
          onKeyDown={e => { if (e.key === 'Enter') onCommitRename(); if (e.key === 'Escape') onCancelRename(); }}
          onClick={e => e.stopPropagation()} />
      ) : (
        <span>{tab.label}</span>
      )}
      <button className="close-btn" onClick={onClose}>×</button>
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

  useEffect(() => { window.pty.notifyActive(activeId); }, [activeId]);

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

  // Bare left/right arrows switch tabs (Option+arrows pass through to terminal)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        setTabs(prev => {
          const idx = prev.findIndex(t => t.id === activeId);
          if (idx === -1) return prev;
          const next = e.key === 'ArrowLeft' ? idx - 1 : idx + 1;
          if (next >= 0 && next < prev.length) setActiveId(prev[next].id);
          return prev;
        });
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [activeId]);

  const [voiceState, setVoiceState] = useState<string>('idle');
  const [voiceTabId, setVoiceTabId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [dateGroups, setDateGroups] = useState<string[]>([]);
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set());
  const [dateSessions, setDateSessions] = useState<Record<string, SessionInfo[]>>({});

  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Track which session IDs are open in tabs: sessionId → tabId
  const [openSessions, setOpenSessions] = useState<Record<string, string>>({});
  const [confirmHideId, setConfirmHideId] = useState<string | null>(null);

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
    return window.sessions.onConfirmHide(setConfirmHideId);
  }, []);

  useEffect(() => {
    return window.voice.onStateChange((state, tabId) => {
      setVoiceState(state);
      setVoiceTabId(tabId);
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
      return;
    }
    const tab: Tab = {
      id: crypto.randomUUID(),
      label: session.title.slice(0, 30),
      resumeSessionId: session.id,
    };
    setTabs(prev => [...prev, tab]);
    setActiveId(tab.id);
  }, [openSessions]);

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
      const next = prev.filter(t => t.id !== id);
      if (next.length === 0) {
        const tab = makeTab();
        setActiveId(tab.id);
        return [tab];
      }
      if (activeId === id) setActiveId(next[next.length - 1].id);
      return next;
    });
  }, [activeId]);

  // Pop out to iTerm → close the tab in the app
  useEffect(() => {
    return window.pty.onPoppedOut((tabId) => {
      closeTab(tabId);
    });
  }, [closeTab]);

  return (
    <div className="app">
      <div className="tab-bar">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={tabs.map(t => t.id)} strategy={horizontalListSortingStrategy}>
            <div className="tabs">
              {tabs.map(tab => (
                <SortableTab key={tab.id} tab={tab} isActive={tab.id === activeId}
                  isRenaming={renamingTabId === tab.id} renameValue={renameValue} renameInputRef={renameInputRef}
                  voiceState={voiceTabId === tab.id && voiceState !== 'idle' ? voiceState : null}
                  onSetActive={() => setActiveId(tab.id)}
                  onContextMenu={e => { e.preventDefault(); window.pty.contextMenu(tab.id); }}
                  onRenameChange={setRenameValue} onCommitRename={commitRename}
                  onCancelRename={() => setRenamingTabId(null)}
                  onClose={e => { e.stopPropagation(); closeTab(tab.id); }} />
              ))}
            </div>
          </SortableContext>
        </DndContext>
        <button className="new-tab-btn" onClick={addTab} title="New session">+</button>
      </div>
      <div className="main-content">
        <div className={`left-panel ${panelOpen ? 'open' : 'collapsed'}`}>
          <div className="panel-content">
            <div className="panel-header">
              <span className="panel-title">Sessions</span>
              <button className="panel-toggle" onClick={() => setPanelOpen(false)}>‹</button>
            </div>
            <div className="session-list">
              {sessions.map(s => (
                <div key={s.id} className={`session-item ${openSessions[s.id] ? 'open' : ''}`}
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
          </div>
        </div>
        {!panelOpen && (
          <button className="panel-expand" onClick={() => setPanelOpen(true)}>›</button>
        )}
        <div className="terminal-area">
          {tabs.map(tab => (
            <TerminalTab key={tab.id} id={tab.id} active={tab.id === activeId} resumeSessionId={tab.resumeSessionId} />
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
