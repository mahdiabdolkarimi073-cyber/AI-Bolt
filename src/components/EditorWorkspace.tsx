import { useCallback } from 'react';
import { X, Circle, Save, AlertCircle, Loader2 } from 'lucide-react';
import { CodeEditor, EditorTab } from './CodeEditor';
import { EmptyState } from './EmptyState';
import type { OpenFileTab } from '@/hooks/useWorkspace';

interface Props {
  tabs: OpenFileTab[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onChangeContent: (id: string, content: string) => void;
  onSave: (id: string) => void;
  hasProject: boolean;
  busy: boolean;
  onOpenProject: () => void;
  onNewProject: () => void;
}

export function EditorWorkspace({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onChangeContent,
  onSave,
  hasProject,
  busy,
  onOpenProject,
  onNewProject,
}: Props) {
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  const handleClose = useCallback(
    (id: string) => {
      const tab = tabs.find((t) => t.id === id);
      if (!tab) return;
      if (tab.dirty) {
        const ok = window.confirm(`"${tab.name}" has unsaved changes. Discard and close?`);
        if (!ok) return;
      }
      onCloseTab(id);
    },
    [tabs, onCloseTab],
  );

  const handleSave = useCallback(
    (id: string) => {
      if (busy) return;
      onSave(id);
    },
    [busy, onSave],
  );

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-surface-950">
      {hasProject && (
        <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-surface-700 bg-surface-850 scrollbar-thin">
          {tabs.map((tab) => (
            <EditorTab
              key={tab.id}
              id={tab.id}
              name={tab.name}
              dirty={tab.dirty}
              active={tab.id === activeTabId}
              onClick={() => onSelectTab(tab.id)}
              onClose={() => handleClose(tab.id)}
            />
          ))}
        </div>
      )}

      {hasProject && activeTab && (
        <div className="flex h-7 shrink-0 items-center gap-1 border-b border-surface-800 bg-surface-900 px-3 text-2xs text-surface-400">
          {activeTab.path.split('/').map((seg, i, arr) => (
            <span key={i} className="flex items-center gap-1">
              <span className={i === arr.length - 1 ? 'text-surface-300' : ''}>{seg}</span>
              {i < arr.length - 1 && <span className="text-surface-500">/</span>}
            </span>
          ))}
          <div className="ml-auto flex items-center gap-2">
            {activeTab.dirty && (
              <span className="flex items-center gap-1 text-accent-400">
                <Circle size={7} fill="currentColor" /> Unsaved
              </span>
            )}
            <button
              onClick={() => handleSave(activeTab.id)}
              disabled={busy || !activeTab.dirty}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-surface-300 transition-colors hover:bg-surface-750 hover:text-accent-400 disabled:opacity-40"
              title="Save (Ctrl+S)"
            >
              {busy ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
              Save
            </button>
          </div>
        </div>
      )}

      {!hasProject ? (
        <EmptyState onOpenProject={onOpenProject} onNewProject={onNewProject} />
      ) : activeTab ? (
        activeTab.error ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 bg-surface-950 px-6 text-center text-sm text-surface-400">
            <AlertCircle size={28} className="text-error-400" />
            <div className="text-sm text-surface-300">{activeTab.name}</div>
            <div className="max-w-md text-2xs text-surface-400">{activeTab.error}</div>
          </div>
        ) : (
          <CodeEditor
            code={activeTab.content}
            language={activeTab.language}
            filename={activeTab.name}
            onChange={(value) => onChangeContent(activeTab.id, value)}
            onSave={() => handleSave(activeTab.id)}
          />
        )
      ) : (
        <div className="flex flex-1 items-center justify-center bg-surface-950 text-sm text-surface-400">
          No file open. Pick one from the Explorer.
        </div>
      )}
    </div>
  );
}
