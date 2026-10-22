import { useState, useRef, useEffect } from 'react';
import {
  ChevronDown,
  FolderOpen,
  Plus,
  Settings as SettingsIcon,
  MoreHorizontal,
  Circle,
  Zap,
} from 'lucide-react';
import { ProviderSelector, type ProviderOption } from './ProviderSelector';
import { Button } from './ui/Button';

interface Props {
  projectName: string;
  providerOptions: ProviderOption[];
  activeConnectionId: string | null;
  activeModelId: string | null;
  onProviderChange: (connectionId: string, modelId: string) => void;
  onOpenProject: () => void;
  onNewProject: () => void;
  onOpenSettings: () => void;
  aiConnected: boolean;
  providerLoading: boolean;
  hasUsableConnections: boolean;
}

export function TopBar({
  projectName,
  providerOptions,
  activeConnectionId,
  activeModelId,
  onProviderChange,
  onOpenProject,
  onNewProject,
  onOpenSettings,
  aiConnected,
  providerLoading,
  hasUsableConnections,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [menuOpen]);

  return (
    <header className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-surface-700 bg-surface-900 px-3">
      {/* Left: logo + product + project */}
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-accent-500 to-accent-700 shadow-sm">
            <Zap size={14} className="text-white" fill="white" />
          </div>
          <span className="hidden text-xs font-semibold tracking-tight text-gray-100 sm:block">
            Personal AI IDE
          </span>
        </div>

        <div className="hidden h-5 w-px bg-surface-700 sm:block" />

        <button
          onClick={onOpenProject}
          className="group flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors hover:bg-surface-750"
          title="Switch project"
        >
          <span className="max-w-[160px] truncate font-medium text-gray-200">{projectName}</span>
          <ChevronDown size={13} className="shrink-0 text-surface-300 transition-transform group-hover:text-gray-100" />
        </button>
      </div>

      {/* Right: actions */}
      <div className="flex items-center gap-2">
        <div className="hidden items-center gap-1.5 rounded-md border border-surface-700 bg-surface-850 px-2 py-1 md:flex">
          <Circle
            size={7}
            className={aiConnected ? 'fill-success-500 text-success-500 animate-pulse-dot' : 'fill-surface-400 text-surface-400'}
            fill="currentColor"
          />
          <span className="text-2xs font-medium text-surface-300">
            {aiConnected ? 'AI Online' : 'AI Offline'}
          </span>
        </div>

        <ProviderSelector
          options={providerOptions}
          activeConnectionId={activeConnectionId}
          activeModelId={activeModelId}
          onChange={onProviderChange}
          loading={providerLoading}
          hasUsableConnections={hasUsableConnections}
          onConfigure={onOpenSettings}
        />

        <div className="hidden h-5 w-px bg-surface-700 sm:block" />

        <Button variant="ghost" size="sm" onClick={onNewProject} className="hidden sm:inline-flex">
          <Plus size={14} /> New
        </Button>
        <Button variant="ghost" size="sm" onClick={onOpenProject} className="hidden sm:inline-flex">
          <FolderOpen size={14} /> Open
        </Button>

        <button
          onClick={onOpenSettings}
          className="rounded-md p-1.5 text-surface-300 transition-colors hover:bg-surface-750 hover:text-gray-100"
          aria-label="Settings"
        >
          <SettingsIcon size={15} />
        </button>

        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen((o) => !o)}
            className="rounded-md p-1.5 text-surface-300 transition-colors hover:bg-surface-750 hover:text-gray-100"
            aria-label="More actions"
            aria-expanded={menuOpen}
          >
            <MoreHorizontal size={15} />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full z-50 mt-1.5 w-52 overflow-hidden rounded-lg border border-surface-600 bg-surface-850 py-1 shadow-modal animate-fade-in">
              {[
                { label: 'New Project', action: onNewProject },
                { label: 'Open Project…', action: onOpenProject },
                { label: 'Settings', action: onOpenSettings },
              ].map((item) => (
                <button
                  key={item.label}
                  onClick={() => {
                    item.action();
                    setMenuOpen(false);
                  }}
                  className="block w-full px-3 py-2 text-left text-xs text-gray-200 transition-colors hover:bg-surface-750"
                >
                  {item.label}
                </button>
              ))}
              <div className="my-1 border-t border-surface-700" />
              <div className="px-3 py-2 text-2xs text-surface-300">Personal AI IDE · v0.1.0</div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
