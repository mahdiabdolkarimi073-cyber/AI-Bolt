import { useState, useCallback, useEffect } from 'react';
import { PanelRightOpen, PanelLeftOpen } from 'lucide-react';
import { TopBar } from './TopBar';
import { Sidebar } from './Sidebar';
import { EditorWorkspace } from './EditorWorkspace';
import { AIChatPanel } from './AIChatPanel';
import { BottomPanel } from './BottomPanel';
import { SettingsDialog } from './SettingsDialog';
import { ProjectDialog } from './ProjectDialog';
import { PromptDialog } from './PromptDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { DiagnoseDialog } from './DiagnoseDialog';
import { ErrorBoundary } from './ErrorBoundary';
import { useSettings } from '@/hooks/useSettings';
import { useAgentChat } from '@/hooks/useAgentChat';
import { useWorkspace, type OpenFileTab } from '@/hooks/useWorkspace';
import { useTerminal } from '@/hooks/useTerminal';
import { useConnections } from '@/hooks/useConnections';
import { config } from '@/config';
import { getRepositories } from '@/services/index';
import { workspaceService } from '@/services/workspace';
import { providers as allProviders } from '@/data/mock';
import type { ProposedChange } from '@/types/execution';
import type { AgentDefaults } from '@/types/connections';
import type {
  ProviderId,
  SidebarSection,
  BottomTab,
  ChatMessage,
  FileNode,
} from '@/types';
import type { Project } from '@/types/domain';

type PromptState =
  | { kind: 'none' }
  | { kind: 'createFile'; parentDir: string }
  | { kind: 'createDir'; parentDir: string }
  | { kind: 'rename'; node: FileNode };

type ConfirmState =
  | { kind: 'none' }
  | { kind: 'delete'; node: FileNode };

export function AppShell() {
  const { state: settingsState, update: updateSettings } = useSettings();
  const persistedSettings =
    settingsState.kind === 'success' ? settingsState.data : null;

  const workspace = useWorkspace();
  const connections = useConnections();

  const activeProject = workspace.activeProject;
  const projectName = activeProject?.name ?? 'No project open';
  const hasProject = activeProject !== null;
  const projectId = activeProject?.id ?? null;

  const [activeProvider, setActiveProvider] = useState<ProviderId>(
    persistedSettings?.activeProvider ?? config.defaultProvider,
  );
  const activeProviderObj = allProviders.find((p) => p.id === activeProvider)!;

  // The active AI connection + model, loaded from the backend. In backend mode
  // these drive the Agent; in fallback mode they stay null and the Agent uses
  // the DevProvider simulation.
  const [agentDefaults, setAgentDefaults] = useState<AgentDefaults | null>(null);

  useEffect(() => {
    if (persistedSettings) {
      setActiveProvider(persistedSettings.activeProvider);
    }
  }, [persistedSettings]);

  // Keep the active connection defaults in sync with the backend. This runs on
  // mount and whenever the connections hook refreshes (e.g. after a connection
  // is created, edited, deleted, or set as default).
  useEffect(() => {
    setAgentDefaults(connections.defaults);
  }, [connections.defaults]);

  // On mount, load projects and optionally reopen the active one.
  useEffect(() => {
    (async () => {
      const list = await workspace.refreshProjects();
      const activeId = persistedSettings?.activeProjectId;
      if (activeId) {
        const target = list.find((p) => p.id === activeId);
        if (target && target.workspacePath) {
          await workspace.openProject(target);
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const [conversationId, setConversationId] = useState<string | null>(null);
  const conversationIdRef = useCallback((id: string) => setConversationId(id), []);

  const agent = useAgentChat({
    conversationId,
    providerId: activeProvider,
    model: agentDefaults?.model ?? activeProviderObj.model,
    connectionId: agentDefaults?.connectionId ?? null,
    // allowSimulation defaults to false in backend mode (so we never silently
    // fake a Gemini response) and true in fallback mode (so the UI is usable
    // without a backend).
    projectId,
  });

  const [simulatedIds, setSimulatedIds] = useState<Set<string>>(new Set());

  const handleSend = useCallback(
    async (text: string) => {
      let cid = conversationId;
      if (!cid) {
        const repos = getRepositories();
        const conv = await repos.conversations.create({ projectId, title: 'New chat' });
        cid = conv.id;
        conversationIdRef(conv.id);
      }
      const result = await agent.send(text, cid);
      if (result?.assistantMessage && (result.meta?.simulated || result.assistantMessage.simulated)) {
        setSimulatedIds((prev) => new Set(prev).add(result.assistantMessage!.id));
      }
    },
    [agent, conversationId, conversationIdRef, projectId],
  );

  const handleStop = useCallback(() => {
    agent.stop();
  }, [agent]);

  const chatMessages: ChatMessage[] = agent.messages.map((m) => ({
    id: m.id,
    role: m.role === 'system' ? 'assistant' : (m.role as 'user' | 'assistant'),
    content: m.content,
    ts: m.createdAt,
  }));
  const chatBusy = agent.busy;

  const [bottomOpen, setBottomOpen] = useState(true);
  const [bottomTab, setBottomTab] = useState<BottomTab>('terminal');
  const [bottomHeight, setBottomHeight] = useState(240);

  const terminal = useTerminal(projectId);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projectDialog, setProjectDialog] = useState<{ open: boolean; mode: 'open' | 'new' }>({
    open: false,
    mode: 'open',
  });

  const [promptState, setPromptState] = useState<PromptState>({ kind: 'none' });
  const [confirmState, setConfirmState] = useState<ConfirmState>({ kind: 'none' });

  // When project changes, reset conversation so a new chat starts for that project.
  useEffect(() => {
    setConversationId(null);
  }, [projectId]);

  const handleProjectOpened = useCallback(
    async (project: Project) => {
      await workspace.refreshProjects();
      await workspace.openProject(project);
      setSidebarSection('explorer');
    },
    [workspace],
  );

  const handleSwitchProject = useCallback(
    async (project: Project) => {
      if (project.workspacePath) {
        await workspace.openProject(project);
        updateSettings({ activeProjectId: project.id });
      } else {
        // Project has no on-disk workspace; can't open files.
        workspace.clearError();
      }
    },
    [workspace, updateSettings],
  );

  // --- File operations ---

  const handleCreateFile = useCallback((parentDir: string) => {
    setPromptState({ kind: 'createFile', parentDir });
  }, []);

  const handleCreateDir = useCallback((parentDir: string) => {
    setPromptState({ kind: 'createDir', parentDir });
  }, []);

  const handleRenameNode = useCallback((node: FileNode) => {
    setPromptState({ kind: 'rename', node });
  }, []);

  const handleDeleteNode = useCallback((node: FileNode) => {
    setConfirmState({ kind: 'delete', node });
  }, []);

  const handlePromptConfirm = useCallback(
    async (value: string) => {
      if (!workspace.activeProject) return;
      const pid = workspace.activeProject.id;
      try {
        if (promptState.kind === 'createFile') {
          const fullPath = promptState.parentDir ? `${promptState.parentDir}/${value}` : value;
          await workspaceService.writeFile(pid, fullPath, '', { overwrite: false });
          await workspace.refreshTree();
        } else if (promptState.kind === 'createDir') {
          const fullPath = promptState.parentDir ? `${promptState.parentDir}/${value}` : value;
          await workspaceService.createDirectory(pid, fullPath);
          await workspace.refreshTree();
        } else if (promptState.kind === 'rename') {
          const node = promptState.node;
          const parentParts = node.id.split('/').slice(0, -1);
          const parent = parentParts.join('/');
          const toPath = parent ? `${parent}/${value}` : value;
          await workspaceService.renamePath(pid, node.id, toPath);
          await workspace.refreshTree();
        }
      } catch (e) {
        workspace.setError(e instanceof Error ? e.message : 'Operation failed');
      }
    },
    [promptState, workspace],
  );

  const handleConfirmDelete = useCallback(
    async () => {
      if (confirmState.kind !== 'delete' || !workspace.activeProject) return;
      const node = confirmState.node;
      try {
        await workspaceService.deletePath(workspace.activeProject.id, node.id, true);
        // Close any open tab for this path.
        const tab = workspace.tabs.find((t) => t.path === node.id);
        if (tab) {
          workspace.closeTab(tab.id, true);
        }
        await workspace.refreshTree();
      } catch (e) {
        workspace.setError(e instanceof Error ? e.message : 'Delete failed');
      }
    },
    [confirmState, workspace],
  );

  const activeTab = workspace.tabs.find((t) => t.id === workspace.activeTabId) ?? null;

  const handleApplyDiagnosis = useCallback(
    async (changes: ProposedChange[]) => {
      if (!workspace.activeProject) return;
      const pid = workspace.activeProject.id;
      for (const change of changes) {
        try {
          const existing = await workspaceService.readFile(pid, change.path);
          const updated = change.original
            ? existing.content.replace(change.original, change.updated)
            : change.updated;
          await workspaceService.writeFile(pid, change.path, updated, { overwrite: true });
        } catch (e) {
          workspace.setError(e instanceof Error ? e.message : 'Failed to apply proposed change.');
        }
      }
      await workspace.refreshTree();
    },
    [workspace],
  );

  const handleRerunDiagnosis = useCallback(
    (sessionId: string) => {
      const session = terminal.sessions.find((s) => s.id === sessionId);
      if (session) {
        void terminal.runCommand({
          command: session.command,
          kind: session.kind,
          source: 'user',
          longRunning: session.longRunning,
        });
      }
      terminal.dismissDiagnosis();
    },
    [terminal],
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
        aiConnected={agentDefaults?.connectionId != null}
      />

      <div className="flex min-h-0 flex-1">
        <ErrorBoundary label="Sidebar">
        <Sidebar
          active={sidebarSection}
          onChange={setSidebarSection}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
          onOpenFile={workspace.openFile}
          onOpenSettings={() => setSettingsOpen(true)}
          onNewProject={() => setProjectDialog({ open: true, mode: 'new' })}
          onOpenProject={() => setProjectDialog({ open: true, mode: 'open' })}
          projects={workspace.projects}
          activeProject={workspace.activeProject}
          onSwitchProject={handleSwitchProject}
          tree={workspace.tree}
          treeLoading={workspace.treeLoading}
          treeError={workspace.treeError}
          activeFilePath={activeTab?.path ?? null}
          onRefreshTree={workspace.refreshTree}
          onCreateFile={handleCreateFile}
          onCreateDir={handleCreateDir}
          onRenameNode={handleRenameNode}
          onDeleteNode={handleDeleteNode}
          onExpandFolder={workspace.loadFolderChildren}
        />
        </ErrorBoundary>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="relative flex min-h-0 flex-1">
            <EditorWorkspace
              tabs={workspace.tabs}
              activeTabId={workspace.activeTabId}
              onSelectTab={workspace.setActiveTabId}
              onCloseTab={workspace.closeTab}
              onChangeContent={workspace.updateTabContent}
              onSave={workspace.saveTab}
              hasProject={hasProject}
              busy={workspace.busy}
              onOpenProject={() => setProjectDialog({ open: true, mode: 'open' })}
              onNewProject={() => setProjectDialog({ open: true, mode: 'new' })}
            />

            {!chatCollapsed ? (
              <div className="w-[380px] shrink-0 xl:w-[420px]">
                <AIChatPanel
                  messages={chatMessages}
                  onSend={handleSend}
                  busy={chatBusy}
                  onStop={handleStop}
                  onCollapse={() => setChatCollapsed(true)}
                  activeProvider={activeProviderObj}
                  simulatedIds={simulatedIds}
                  error={agent.lastError}
                  onDismissError={agent.clearError}
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
            terminal={terminal}
            height={bottomHeight}
          />
        </div>
      </div>

      {workspace.error && (
        <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-error-500/30 bg-surface-850 px-4 py-2 text-xs text-error-400 shadow-xl">
          {workspace.error}
          <button
            onClick={workspace.clearError}
            className="ml-3 text-surface-300 hover:text-gray-100"
          >
            Dismiss
          </button>
        </div>
      )}

      <SettingsDialog
        open={settingsOpen}
        onClose={() => {
          setSettingsOpen(false);
          // Refresh connection defaults so the Agent picks up any changes made
          // in the Settings dialog (new connection, edited model, new default).
          void connections.refresh();
        }}
        providers={allProviders}
        activeProvider={activeProvider}
        onProviderChange={handleProviderChange}
        onSave={() => {}}
      />
      <ProjectDialog
        open={projectDialog.open}
        mode={projectDialog.mode}
        onClose={() => setProjectDialog({ open: false, mode: projectDialog.mode })}
        onProjectOpened={handleProjectOpened}
        onProjectCreated={handleProjectOpened}
      />

      <PromptDialog
        open={promptState.kind === 'createFile'}
        title="New file"
        label="File name (path relative to project root)"
        placeholder="src/main.ts"
        confirmLabel="Create"
        onConfirm={handlePromptConfirm}
        onClose={() => setPromptState({ kind: 'none' })}
      />
      <PromptDialog
        open={promptState.kind === 'createDir'}
        title="New folder"
        label="Folder name"
        placeholder="src/components"
        confirmLabel="Create"
        onConfirm={handlePromptConfirm}
        onClose={() => setPromptState({ kind: 'none' })}
      />
      <PromptDialog
        open={promptState.kind === 'rename'}
        title="Rename"
        label="New name"
        initialValue={promptState.kind === 'rename' ? promptState.node.name : ''}
        confirmLabel="Rename"
        onConfirm={handlePromptConfirm}
        onClose={() => setPromptState({ kind: 'none' })}
      />

      <ConfirmDialog
        open={confirmState.kind === 'delete'}
        title="Delete"
        message={
          confirmState.kind === 'delete'
            ? `Are you sure you want to delete "${confirmState.node.name}"? This cannot be undone.`
            : ''
        }
        confirmLabel="Delete"
        destructive
        onConfirm={handleConfirmDelete}
        onClose={() => setConfirmState({ kind: 'none' })}
      />

      <DiagnoseDialog
        open={terminal.pendingDiagnosis !== null}
        analysis={terminal.pendingDiagnosis?.analysis ?? ''}
        changes={terminal.pendingDiagnosis?.changes ?? []}
        busy={terminal.diagnosisBusy}
        applying={false}
        onApply={handleApplyDiagnosis}
        onRerun={terminal.pendingDiagnosis ? () => handleRerunDiagnosis(terminal.pendingDiagnosis!.sessionId) : undefined}
        onClose={() => terminal.dismissDiagnosis()}
      />
    </div>
  );
}
