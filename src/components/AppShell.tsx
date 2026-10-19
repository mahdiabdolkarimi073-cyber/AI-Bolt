import { useState, useCallback, useEffect } from 'react';
import { PanelRightOpen, PanelLeftOpen } from 'lucide-react';
import { TopBar } from './TopBar';
import { Sidebar } from './Sidebar';
import { EditorWorkspace } from './EditorWorkspace';
import { AIChatPanel } from './AIChatPanel';
import { BottomPanel } from './BottomPanel';
import { SettingsDialog } from './SettingsDialog';
import { ProjectDialog } from './ProjectDialog';
import { useSettings } from '@/hooks/useSettings';
import { config } from '@/config';
import {
  providers as allProviders,
  initialTabs,
  initialChat,
  sampleFileContents,
} from '@/data/mock';
import type {
  ProviderId,
  SidebarSection,
  BottomTab,
  OpenTab,
  ChatMessage,
  FileNode,
} from '@/types';

export function AppShell() {
  const { state: settingsState, update: updateSettings } = useSettings();
  const persistedSettings =
    settingsState.kind === 'success' ? settingsState.data : null;

  const [projectName, setProjectName] = useState('No project open');
  const [hasProject, setHasProject] = useState(false);

  const [activeProvider, setActiveProvider] = useState<ProviderId>(
    persistedSettings?.activeProvider ?? config.defaultProvider,
  );
  const activeProviderObj = allProviders.find((p) => p.id === activeProvider)!;

  // Restore the active provider once settings have loaded.
  useEffect(() => {
    if (persistedSettings) {
      setActiveProvider(persistedSettings.activeProvider);
    }
  }, [persistedSettings]);

  const handleProviderChange = useCallback(
    (id: ProviderId) => {
      setActiveProvider(id);
      updateSettings({ activeProvider: id });
    },
    [updateSettings],
  );

  const [sidebarSection, setSidebarSection] = useState<SidebarSection>('explorer');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(initialChat);
  const [chatBusy, setChatBusy] = useState(false);

  const [bottomOpen, setBottomOpen] = useState(true);
  const [bottomTab, setBottomTab] = useState<BottomTab>('terminal');

  const [tabs, setTabs] = useState<OpenTab[]>(hasProject ? initialTabs : []);
  const [activeTabId, setActiveTabId] = useState<string | null>(hasProject ? initialTabs[0]?.id ?? null : null);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projectDialog, setProjectDialog] = useState<{ open: boolean; mode: 'open' | 'new' }>({
    open: false,
    mode: 'open',
  });

  const openProject = useCallback((name: string) => {
    setProjectName(name);
    setHasProject(true);
    setTabs(initialTabs);
    setActiveTabId(initialTabs[0].id);
    setSidebarSection('explorer');
  }, []);

  const handleSend = useCallback((text: string) => {
    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: text,
      ts: Date.now(),
    };
    setChatMessages((prev) => [...prev, userMsg]);
    setChatBusy(true);

    window.setTimeout(() => {
      const reply: ChatMessage = {
        id: `a-${Date.now()}`,
        role: 'assistant',
        content: 'Got it. In this demo phase I can\'t run real edits yet, but this is where the AI would plan and execute your request step by step.',
        steps: [
          { id: 's1', label: 'Analyze request', status: 'done' },
          { id: 's2', label: 'Plan changes', status: 'done' },
          { id: 's3', label: 'Apply edits', status: 'pending' },
        ],
        ts: Date.now(),
      };
      setChatMessages((prev) => [...prev, reply]);
      setChatBusy(false);
    }, 1100);
  }, []);

  const handleStop = useCallback(() => setChatBusy(false), []);

  const handleOpenFile = useCallback((node: FileNode) => {
    if (node.type !== 'file') return;
    const existing = tabs.find((t) => t.name === node.name);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const newTab: OpenTab = {
      id: `t-${Date.now()}`,
      name: node.name,
      path: `src/${node.name}`,
      language: node.language ?? 'tsx',
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);
  }, [tabs]);

  const handleCloseTab = useCallback(
    (id: string) => {
      setTabs((prev) => {
        const next = prev.filter((t) => t.id !== id);
        if (activeTabId === id) {
          setActiveTabId(next[next.length - 1]?.id ?? null);
        }
        return next;
      });
    },
    [activeTabId]
  );

  return (
    <div className="flex h-screen min-h-0 flex-col overflow-hidden bg-surface-950 text-gray-200">
      <TopBar
        projectName={projectName}
        providers={allProviders}
        activeProvider={activeProvider}
        onProviderChange={handleProviderChange}
        onOpenProject={() => setProjectDialog({ open: true, mode: 'open' })}
        onNewProject={() => setProjectDialog({ open: true, mode: 'new' })}
        onOpenSettings={() => setSettingsOpen(true)}
        aiConnected={activeProviderObj.status === 'connected'}
      />

      <div className="flex min-h-0 flex-1">
        <Sidebar
          active={sidebarSection}
          onChange={setSidebarSection}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
          onOpenFile={handleOpenFile}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        {/* Center column: editor + bottom panel */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="relative flex min-h-0 flex-1">
            <EditorWorkspace
              tabs={tabs}
              activeTabId={activeTabId}
              onSelectTab={setActiveTabId}
              onCloseTab={handleCloseTab}
              fileContents={sampleFileContents}
              hasProject={hasProject}
              onOpenProject={() => setProjectDialog({ open: true, mode: 'open' })}
              onNewProject={() => setProjectDialog({ open: true, mode: 'new' })}
            />

            {/* Chat panel */}
            {!chatCollapsed ? (
              <div className="w-[380px] shrink-0 xl:w-[420px]">
                <AIChatPanel
                  messages={chatMessages}
                  onSend={handleSend}
                  busy={chatBusy}
                  onStop={handleStop}
                  onCollapse={() => setChatCollapsed(true)}
                  activeProvider={activeProviderObj}
                />
              </div>
            ) : (
              <button
                onClick={() => setChatCollapsed(false)}
                className="flex w-9 shrink-0 flex-col items-center justify-center gap-1.5 border-l border-surface-700 bg-surface-850 text-surface-300 transition-colors hover:bg-surface-800 hover:text-accent-400"
                aria-label="Expand chat panel"
                title="Expand AI chat"
              >
                <PanelRightOpen size={16} />
                <span className="text-2xs [writing-mode:vertical-rl] rotate-180">AI Assistant</span>
              </button>
            )}
          </div>

          {/* Sidebar re-expand button (when collapsed) */}
          {sidebarCollapsed && (
            <button
              onClick={() => setSidebarCollapsed(false)}
              className="absolute left-12 top-1/2 z-10 hidden -translate-y-1/2 rounded-r-md border border-l-0 border-surface-700 bg-surface-850 p-1 text-surface-300 transition-colors hover:bg-surface-800 hover:text-gray-100"
              aria-label="Expand sidebar"
              title="Expand sidebar"
            >
              <PanelLeftOpen size={14} />
            </button>
          )}

          <BottomPanel
            open={bottomOpen}
            onToggle={() => setBottomOpen((o) => !o)}
            activeTab={bottomTab}
            onTabChange={setBottomTab}
          />
        </div>
      </div>

      {/* Dialogs */}
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        providers={allProviders}
        activeProvider={activeProvider}
        onProviderChange={handleProviderChange}
        onSave={() => {}}
      />
      <ProjectDialog
        open={projectDialog.open}
        mode={projectDialog.mode}
        onClose={() => setProjectDialog({ open: false, mode: projectDialog.mode })}
        onConfirm={(name) => {
          openProject(name);
          setProjectDialog({ open: false, mode: projectDialog.mode });
        }}
      />
    </div>
  );
}
