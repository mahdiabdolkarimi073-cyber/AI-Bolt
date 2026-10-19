import { X, Circle } from 'lucide-react';
import { CodeEditor, EditorTab } from './CodeEditor';
import { EmptyState } from './EmptyState';
import type { OpenTab } from '@/types';

interface Props {
  tabs: OpenTab[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  fileContents: Record<string, string>;
  hasProject: boolean;
  onOpenProject: () => void;
  onNewProject: () => void;
}

export function EditorWorkspace({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  fileContents,
  hasProject,
  onOpenProject,
  onNewProject,
}: Props) {
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-surface-950">
      {/* Tabs row */}
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
              onClose={() => onCloseTab(tab.id)}
            />
          ))}
        </div>
      )}

      {/* Breadcrumb / active file path */}
      {hasProject && activeTab && (
        <div className="flex h-7 shrink-0 items-center gap-1 border-b border-surface-800 bg-surface-900 px-3 text-2xs text-surface-400">
          {activeTab.path.split('/').map((seg, i, arr) => (
            <span key={i} className="flex items-center gap-1">
              <span className={i === arr.length - 1 ? 'text-surface-300' : ''}>{seg}</span>
              {i < arr.length - 1 && <span className="text-surface-500">/</span>}
            </span>
          ))}
          {activeTab.dirty && (
            <span className="ml-2 flex items-center gap-1 text-accent-400">
              <Circle size={7} fill="currentColor" /> Unsaved
            </span>
          )}
        </div>
      )}

      {/* Editor or empty state */}
      {!hasProject ? (
        <EmptyState onOpenProject={onOpenProject} onNewProject={onNewProject} />
      ) : activeTab ? (
        <CodeEditor
          code={fileContents[activeTab.name] ?? '// File content not available in this demo.'}
          language={activeTab.language}
          filename={activeTab.name}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center bg-surface-950 text-sm text-surface-400">
          No file open. Pick one from the Explorer.
        </div>
      )}
    </div>
  );
}
