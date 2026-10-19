import { useState } from 'react';
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
} from 'lucide-react';
import { ProjectExplorer } from './ProjectExplorer';
import { sampleFileTree, sampleChatHistory } from '@/data/mock';
import type { SidebarSection, FileNode } from '@/types';

interface Props {
  active: SidebarSection;
  onChange: (s: SidebarSection) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onOpenFile: (n: FileNode) => void;
  onOpenSettings: () => void;
}

const sections: { id: SidebarSection; label: string; icon: typeof FolderTree }[] = [
  { id: 'projects', label: 'Projects', icon: FolderKanban },
  { id: 'explorer', label: 'Explorer', icon: FolderTree },
  { id: 'search', label: 'Search', icon: Search },
  { id: 'history', label: 'Chat History', icon: MessageSquareText },
  { id: 'knowledge', label: 'Knowledge Base', icon: BookMarked },
];

export function Sidebar({ active, onChange, collapsed, onToggleCollapse, onOpenFile, onOpenSettings }: Props) {
  const [query, setQuery] = useState('');

  return (
    <div className="flex h-full min-w-0">
      {/* Activity rail (icon strip) */}
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

      {/* Secondary panel */}
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
            {active === 'projects' && <ProjectsPanel />}
            {active === 'explorer' && <ProjectExplorer nodes={sampleFileTree} onOpenFile={onOpenFile} />}
            {active === 'search' && <SearchPanel query={query} setQuery={setQuery} />}
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

function ProjectsPanel() {
  const projects = [
    { name: 'personal-ai-ide', active: true },
    { name: 'landing-page', active: false },
    { name: 'api-server', active: false },
  ];
  return (
    <div className="py-1">
      <PanelHeader action={<button className="rounded p-0.5 text-surface-300 hover:bg-surface-700 hover:text-gray-100"><Plus size={13} /></button>}>
        Recent
      </PanelHeader>
      <div className="px-1.5">
        {projects.map((p) => (
          <button
            key={p.name}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
              p.active ? 'bg-surface-750 text-gray-100' : 'text-surface-300 hover:bg-surface-750 hover:text-gray-100'
            }`}
          >
            <FolderKanban size={14} className={p.active ? 'text-accent-400' : 'text-surface-400'} />
            <span className="truncate font-mono text-[11px]">{p.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function SearchPanel({ query, setQuery }: { query: string; setQuery: (v: string) => void }) {
  return (
    <div className="p-2">
      <div className="relative">
        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-surface-300" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search files and content"
          className="w-full rounded-md border border-surface-600 bg-surface-800 py-1.5 pl-8 pr-2 text-2xs text-gray-100 placeholder:text-surface-400 focus:border-accent-500/60 focus:outline-none"
        />
      </div>
      {query && (
        <div className="mt-3 space-y-1 text-2xs text-surface-300">
          <p className="px-1">No results yet — search is a demo in this phase.</p>
        </div>
      )}
    </div>
  );
}

function HistoryPanel() {
  return (
    <div className="py-1">
      <PanelHeader action={<History size={13} className="text-surface-300" />}>Recent chats</PanelHeader>
      <div className="px-1.5">
        {sampleChatHistory.map((h) => (
          <button
            key={h.id}
            className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-750"
          >
            <span className="truncate text-[11px] text-gray-200">{h.title}</span>
            <span className="text-2xs text-surface-400">{h.ts}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function KnowledgePanel() {
  const items = [
    { name: 'Project conventions', count: 12 },
    { name: 'API reference', count: 8 },
    { name: 'Design system', count: 5 },
  ];
  return (
    <div className="py-1">
      <PanelHeader action={<button className="rounded p-0.5 text-surface-300 hover:bg-surface-700 hover:text-gray-100"><Plus size={13} /></button>}>
        Collections
      </PanelHeader>
      <div className="px-1.5">
        {items.map((i) => (
          <button
            key={i.name}
            className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-750"
          >
            <span className="flex items-center gap-2 truncate text-[11px] text-gray-200">
              <BookMarked size={13} className="text-violet-400" />
              {i.name}
            </span>
            <span className="text-2xs text-surface-400">{i.count}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
