import { useState, useCallback, useEffect, useRef } from 'react';
import {
  FolderTree,
  Search,
  MessageSquareText,
  BookMarked,
  Settings as SettingsIcon,
  FolderKanban,
  ChevronLeft,
  Plus,
  History,
  Loader2,
} from 'lucide-react';
import { ProjectExplorer } from './ProjectExplorer';
import { workspaceService, type SearchResult } from '@/services/workspace';
import { getRepositories } from '@/services/index';
import type { SidebarSection, FileNode } from '@/types';
import type { Project } from '@/types/domain';

interface Props {
  active: SidebarSection;
  onChange: (s: SidebarSection) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onOpenFile: (n: FileNode) => void;
  onOpenSettings: () => void;
  onNewProject: () => void;
  onOpenProject: () => void;
  projects: Project[];
  activeProject: Project | null;
  onSwitchProject: (p: Project) => void;
  tree: FileNode[];
  treeLoading: boolean;
  treeError: string | null;
  activeFilePath: string | null;
  onRefreshTree: () => void;
  onCreateFile: (parentDir: string) => void;
  onCreateDir: (parentDir: string) => void;
  onRenameNode: (node: FileNode) => void;
  onDeleteNode: (node: FileNode) => void;
  onExpandFolder: (folderPath: string) => void;
}

const sections: { id: SidebarSection; label: string; icon: typeof FolderTree }[] = [
  { id: 'projects', label: 'Projects', icon: FolderKanban },
  { id: 'explorer', label: 'Explorer', icon: FolderTree },
  { id: 'search', label: 'Search', icon: Search },
  { id: 'history', label: 'Chat History', icon: MessageSquareText },
  { id: 'knowledge', label: 'Knowledge Base', icon: BookMarked },
];

export function Sidebar({
  active,
  onChange,
  collapsed,
  onToggleCollapse,
  onOpenFile,
  onOpenSettings,
  onNewProject,
  onOpenProject,
  projects,
  activeProject,
  onSwitchProject,
  tree,
  treeLoading,
  treeError,
  activeFilePath,
  onRefreshTree,
  onCreateFile,
  onCreateDir,
  onRenameNode,
  onDeleteNode,
  onExpandFolder,
}: Props) {
  return (
    <div className="flex h-full min-w-0">
      <nav className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-surface-700 bg-surface-900 py-2">
        {sections.map((s) => {
          const Icon = s.icon;
          const selected = active === s.id;
          return (
            <button
              key={s.id}
              onClick={() => onChange(s.id)}
              className={`group relative flex h-9 w-9 items-center justify-center rounded-lg transition-colors ${
                selected ? 'bg-surface-750 text-accent-400' : 'text-surface-300 hover:bg-surface-800 hover:text-gray-100'
              }`}
              aria-label={s.label}
              aria-pressed={selected}
              title={s.label}
            >
              {selected && <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r bg-accent-500" />}
              <Icon size={18} />
            </button>
          );
        })}
        <div className="mt-auto">
          <button
            onClick={onOpenSettings}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-surface-300 transition-colors hover:bg-surface-800 hover:text-gray-100"
            aria-label="Settings"
            title="Settings"
          >
            <SettingsIcon size={18} />
          </button>
        </div>
      </nav>

      {!collapsed && (
        <aside className="flex w-60 shrink-0 flex-col border-r border-surface-700 bg-surface-850">
          <div className="flex h-8 shrink-0 items-center justify-between border-b border-surface-700 px-3">
            <span className="text-2xs font-semibold uppercase tracking-wider text-surface-300">
              {sections.find((s) => s.id === active)?.label}
            </span>
            <button
              onClick={onToggleCollapse}
              className="rounded p-0.5 text-surface-300 transition-colors hover:bg-surface-700 hover:text-gray-100"
              aria-label="Collapse sidebar"
            >
              <ChevronLeft size={14} />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
            {active === 'projects' && (
              <ProjectsPanel
                projects={projects}
                activeProject={activeProject}
                onSwitch={onSwitchProject}
                onNewProject={onNewProject}
                onOpenProject={onOpenProject}
              />
            )}
            {active === 'explorer' && (
              activeProject ? (
                <ProjectExplorer
                  nodes={tree}
                  loading={treeLoading}
                  error={treeError}
                  activePath={activeFilePath}
                  onOpenFile={onOpenFile}
                  onCreateFile={onCreateFile}
                  onCreateDir={onCreateDir}
                  onRename={onRenameNode}
                  onDelete={onDeleteNode}
                  onRefresh={onRefreshTree}
                  onExpandFolder={onExpandFolder}
                />
              ) : (
                <div className="px-3 py-4 text-2xs text-surface-400">
                  No project open. Open or import one to browse files.
                </div>
              )
            )}
            {active === 'search' && (
              <SearchPanel projectId={activeProject?.id ?? null} onOpenFile={onOpenFile} />
            )}
            {active === 'history' && <HistoryPanel />}
            {active === 'knowledge' && <KnowledgePanel />}
          </div>
        </aside>
      )}
    </div>
  );
}

function PanelHeader({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-3 pt-2 pb-1">
      <span className="text-2xs font-medium uppercase tracking-wider text-surface-300">{children}</span>
      {action}
    </div>
  );
}

function ProjectsPanel({
  projects,
  activeProject,
  onSwitch,
  onNewProject,
  onOpenProject,
}: {
  projects: Project[];
  activeProject: Project | null;
  onSwitch: (p: Project) => void;
  onNewProject: () => void;
  onOpenProject: () => void;
}) {
  return (
    <div className="py-1">
      <PanelHeader
        action={
          <div className="flex items-center gap-0.5">
            <button
              onClick={onNewProject}
              className="rounded p-0.5 text-surface-300 hover:bg-surface-700 hover:text-gray-100"
              title="New / Import"
            >
              <Plus size={13} />
            </button>
            <button
              onClick={onOpenProject}
              className="rounded p-0.5 text-surface-300 hover:bg-surface-700 hover:text-gray-100"
              title="Open existing"
            >
              <FolderKanban size={13} />
            </button>
          </div>
        }
      >
        Projects
      </PanelHeader>
      <div className="px-1.5">
        {projects.length === 0 ? (
          <div className="px-2 py-3 text-2xs text-surface-400">
            No projects yet. Click + to import or create one.
          </div>
        ) : (
          projects.map((p) => {
            const isActive = activeProject?.id === p.id;
            return (
              <button
                key={p.id}
                onClick={() => onSwitch(p)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                  isActive ? 'bg-surface-750 text-gray-100' : 'text-surface-300 hover:bg-surface-750 hover:text-gray-100'
                }`}
              >
                <FolderKanban size={14} className={isActive ? 'text-accent-400' : 'text-surface-400'} />
                <span className="truncate font-mono text-[11px]">{p.name}</span>
                {!p.workspacePath && (
                  <span className="ml-auto text-2xs text-warning-500">no ws</span>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

function SearchPanel({
  projectId,
  onOpenFile,
}: {
  projectId: string | null;
  onOpenFile: (n: FileNode) => void;
}) {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'filename' | 'content'>('filename');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runSearch = useCallback(
    async (q: string) => {
      if (!projectId || !q.trim()) {
        setResults([]);
        setSearched(false);
        return;
      }
      setSearching(true);
      try {
        const res = await workspaceService.search(projectId, q.trim(), mode, 50);
        setResults(res.results);
        setSearched(true);
      } catch {
        setResults([]);
        setSearched(true);
      } finally {
        setSearching(false);
      }
    },
    [projectId, mode],
  );

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setResults([]);
      setSearched(false);
      return;
    }
    debounceRef.current = setTimeout(() => runSearch(query), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, runSearch]);

  return (
    <div className="p-2">
      <div className="relative">
        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-surface-300" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={projectId ? 'Search files and content' : 'Open a project first'}
          disabled={!projectId}
          className="w-full rounded-md border border-surface-600 bg-surface-800 py-1.5 pl-8 pr-2 text-2xs text-gray-100 placeholder:text-surface-400 focus:border-accent-500/60 focus:outline-none disabled:opacity-50"
        />
      </div>
      <div className="mt-2 flex gap-1">
        <button
          onClick={() => setMode('filename')}
          className={`rounded px-2 py-1 text-2xs transition-colors ${
            mode === 'filename' ? 'bg-surface-700 text-gray-100' : 'text-surface-300 hover:bg-surface-750'
          }`}
        >
          Filenames
        </button>
        <button
          onClick={() => setMode('content')}
          className={`rounded px-2 py-1 text-2xs transition-colors ${
            mode === 'content' ? 'bg-surface-700 text-gray-100' : 'text-surface-300 hover:bg-surface-750'
          }`}
        >
          Content
        </button>
      </div>
      {searching && (
        <div className="mt-3 flex items-center gap-2 text-2xs text-surface-300">
          <Loader2 size={12} className="animate-spin" /> Searching…
        </div>
      )}
      {!searching && searched && results.length === 0 && (
        <div className="mt-3 text-2xs text-surface-400">No results.</div>
      )}
      {results.length > 0 && (
        <div className="mt-2 space-y-0.5">
          {results.map((r, i) => (
            <button
              key={`${r.path}-${i}`}
              onClick={() =>
                onOpenFile({
                  id: r.path,
                  name: r.name,
                  type: 'file',
                  language: undefined,
                })
              }
              className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-750"
            >
              <span className="truncate font-mono text-[11px] text-gray-200">{r.path}</span>
              {r.line !== null && (
                <span className="truncate text-2xs text-surface-400">
                  L{r.line}: {r.match}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function HistoryPanel() {
  const [conversations, setConversations] = useState<{ id: string; title: string; updatedAt: number }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const repos = getRepositories();
        const list = await repos.conversations.list();
        if (!cancelled) {
          setConversations(
            list.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt })),
          );
        }
      } catch {
        // non-fatal
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="py-1">
      <PanelHeader action={<History size={13} className="text-surface-300" />}>Recent chats</PanelHeader>
      <div className="px-1.5">
        {loading ? (
          <div className="px-2 py-3 text-2xs text-surface-400">Loading…</div>
        ) : conversations.length === 0 ? (
          <div className="px-2 py-3 text-2xs text-surface-400">No conversations yet.</div>
        ) : (
          conversations.map((h) => (
            <button
              key={h.id}
              className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-750"
            >
              <span className="truncate text-[11px] text-gray-200">{h.title}</span>
              <span className="text-2xs text-surface-400">
                {new Date(h.updatedAt).toLocaleDateString()}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function KnowledgePanel() {
  return (
    <div className="py-1">
      <PanelHeader action={<button className="rounded p-0.5 text-surface-300 hover:bg-surface-700 hover:text-gray-100"><Plus size={13} /></button>}>
        Collections
      </PanelHeader>
      <div className="px-1.5 py-2 text-2xs text-surface-400">
        Knowledge base entries are managed in the Memory panel.
      </div>
    </div>
  );
}
