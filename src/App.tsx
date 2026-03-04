import { useState, useCallback } from 'react';
import TerminalTab from './TerminalTab';
import './App.css';

interface Tab { id: string; label: string; }

let counter = 1;
const makeTab = (): Tab => ({ id: crypto.randomUUID(), label: `Session ${counter++}` });

export default function App() {
  const [tabs, setTabs] = useState<Tab[]>(() => [makeTab()]);
  const [activeId, setActiveId] = useState<string>(() => tabs[0].id);

  const addTab = useCallback(() => {
    const tab = makeTab();
    setTabs(prev => [...prev, tab]);
    setActiveId(tab.id);
  }, []);

  const closeTab = useCallback((id: string) => {
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

  return (
    <div className="app">
      <div className="tab-bar">
        <div className="tabs">
          {tabs.map(tab => (
            <div
              key={tab.id}
              className={`tab ${tab.id === activeId ? 'active' : ''}`}
              onClick={() => setActiveId(tab.id)}
            >
              <span>{tab.label}</span>
              <button className="close-btn" onClick={e => { e.stopPropagation(); closeTab(tab.id); }}>×</button>
            </div>
          ))}
        </div>
        <button className="new-tab-btn" onClick={addTab} title="New session">+</button>
      </div>
      <div className="terminal-area">
        {tabs.map(tab => (
          <TerminalTab key={tab.id} id={tab.id} active={tab.id === activeId} />
        ))}
      </div>
    </div>
  );
}
