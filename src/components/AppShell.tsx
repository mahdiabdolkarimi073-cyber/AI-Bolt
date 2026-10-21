import { useState, useCallback, useEffect, useMemo } from 'react';
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
import { useAgentChat } from '@/hooks/useAgentChat';
import { useWorkspace, type OpenFileTab } from '@/hooks/useWorkspace';
import { useTerminal } from '@/hooks/useTerminal';
import { usePreview } from '@/hooks/usePreview';
import { useConnections } from '@/hooks/useConnections';
import { config } from '@/config';
import { getRepositories } from '@/services/index';
import { workspaceService } from '@/services/workspace';
import { buildProviderOptions } from './ProviderSelector';
import type { ProposedChange } from '@/types/execution';
import type {
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
  const workspace = useWorkspace();
  const connections = useConnections();

  const activeProject = workspace.activeProject;
  const projectName = activeProject?.name ?? 'No project open';
  const hasProject = activeProject !== null;
  const projectId = activeProject?.id ?? null;

  // Build the list of usable provider options from database connections.
  // Only enabled connections with at least one enabled credential and enabled
  // model appear. Disabled connections, disabled models, and keyless
  // connections are filtered out.
  const providerOptions = useMemo(
    () => buildProviderOptions(connections.connections),
    [connections.connections],
  );
  const hasUsableConnections = providerOptions.length > 0;

  // The active AI connection + model, driven by the database. On startup we
  // restore the saved agent defaults; the user can change selection from the
  // toolbar, which persists the new selection back to the backend.
  const [activeConnectionId, setActiveConnectionId] = useState<string | null>(null);
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const [selectionInitialized, setSelectionInitialized] = useState(false);

  // Initialize selection from backend agent defaults on first load.
  useEffect(() => {
    if (selectionInitialized || connections.loading) return;
    const defaults = connections.defaults;
    if (defaults?.connectionId && defaults?.model) {
      // Validate that the saved default is still a usable option.
      const valid = providerOptions.some(
        (o) => o.connectionId === defaults.connectionId && o.modelId === defaults.model,
      );
      if (valid) {
        setActiveConnectionId(defaults.connectionId);
        setActiveModelId(defaults.model);
      } else if (hasUsableConnections) {
        // Saved default is stale — pick the first usable option.
        setActiveConnectionId(providerOptions[0].connectionId);
        setActiveModelId(providerOptions[0].modelId);
      }
    } else if (hasUsableConnections) {
      // No saved default — pick the first usable option.
      setActiveConnectionId(providerOptions[0].connectionId);
      setActiveModelId(providerOptions[0].modelId);
    }
    setSelectionInitialized(true);
  }, [selectionInitialized, connections.loading, connections.defaults, providerOptions, hasUsableConnections]);

  // When connections refresh (e.g. after Settings changes), validate the
  // current selection. If the selected connection or model was removed or
  // disabled, fall back to the first usable option. Don't overwrite a valid
  // user selection.
  useEffect(() => {
    if (!selectionInitialized) return;
    if (!activeConnectionId || !activeModelId) {
      if (hasUsableConnections) {
        setActiveConnectionId(providerOptions[0].connectionId);
        setActiveModelId(providerOptions[0].modelId);
      }
      return;
    }
    const stillValid = providerOptions.some(
      (o) => o.connectionId === activeConnectionId && o.modelId === activeModelId,
    );
    if (!stillValid) {
      if (hasUsableConnections) {
        setActiveConnectionId(providerOptions[0].connectionId);
        setActiveModelId(providerOptions[0].modelId);
      } else {
        setActiveConnectionId(null);
        setActiveModelId(null);
      }
    }
  }, [providerOptions, activeConnectionId, activeModelId, hasUsableConnections, selectionInitialized]);

  // On mount, load projects and optionally reopen the active one.
  useEffect(() => {
    (async () => {
      const list = await workspace.refreshProjects();
      // Could restore last-opened project here if settings supported it.
      void list;
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleProviderChange = useCallback(
    (connectionId: string, modelId: string) => {
      setActiveConnectionId(connectionId);
      setActiveModelId(modelId);
      // Persist the selection to the backend so it survives restarts.
      void connections.setDefaults(connectionId, modelId);
    },
    [connections],
  );

  const [sidebarSection, setSidebarSection] = useState<SidebarSection>('explorer');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(false);

  const [conversationId, setConversationId] = useState<string | null>(null);
  const conversationIdRef = useCallback((id: string) => setConversationId(id), []);

  const handleAgentFileChange = useCallback(
    (event: { path: string; action: string; oldPath?: string }) => {
      // Refresh the explorer tree so newly created/modified/deleted files appear.
      void workspace.refreshTree();
      // If a file was created or modified, auto-open it in the editor.
      if ((event.action === 'created' || event.action === 'modified') && event.path) {
        const node: FileNode = {
          id: event.path,
          name: event.path.split('/').pop() ?? event.path,
          type: 'file',
        };
        void workspace.openFile(node);
      }
    },
    [workspace],
  );

  const handleAgentProjectCreated = useCallback(
    async (event: { projectId: string; workspacePath: string; files: string[] }) => {
      // Refresh the project list so the new project appears in the sidebar.
      const list = await workspace.refreshProjects();
      // Find the newly created project from the fresh list and open it.
      const newProject = list.find((p) => p.id === event.projectId);
      if (newProject) {
        await workspace.openProject(newProject);
        setSidebarSection('explorer');
      }
    },
    [workspace],
  );

  const agent = useAgentChat({
    conversationId,
    providerId: 'gemini' as const,
    model: activeModelId ?? '',
    connectionId: activeConnectionId,
    projectId,
    onFileChange: handleAgentFileChange,
    onProjectCreated: handleAgentProjectCreated,
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
      // If the agent executed filesystem tools, refresh the Explorer tree so
      // newly created/modified files appear immediately.
      if (result?.toolsExecuted && result.toolsExecuted.length > 0) {
        await workspace.refreshTree();
        // Auto-start preview if the agent finished successfully and no preview
        // server is currently running. Switch to the Preview tab so the user
        // sees the server starting.
        if (result.status === 'completed' && preview.state === 'idle' && !preview.starting) {
          setBottomTab('preview');
          setBottomOpen(true);
          void preview.start();
        }
      }
    },
    [agent, conversationId, conversationIdRef, projectId, workspace, preview],
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

  // Find the active connection detail for the chat header label.
  const activeConn = connections.connections.find((c) => c.id === activeConnectionId);
  const chatConnectionLabel = activeConn?.displayName ?? 'No connection';
  const chatModelLabel = activeModelId ?? 'No model';
  const chatConnected = activeConn?.status === 'connected';

  const [bottomOpen, setBottomOpen] = useState(true);
  const [bottomTab, setBottomTab] = useState<BottomTab>('terminal');
  const [bottomHeight, setBottomHeight] = useState(240);

  const terminal = useTerminal(projectId);
  const preview = usePreview(projectId);

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
        setSidebarSection('explorer');
      } else {
        workspace.clearError();
      }
    },
    [workspace],
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
        providerOptions={providerOptions}
        activeConnectionId={activeConnectionId}
        activeModelId={activeModelId}
        onProviderChange={handleProviderChange}
        onOpenProject={() => setProjectDialog({ open: true, mode: 'open' })}
        onNewProject={() => setProjectDialog({ open: true, mode: 'new' })}
        onOpenSettings={() => setSettingsOpen(true)}
        aiConnected={activeConnectionId != null}
        providerLoading={connections.loading}
        hasUsableConnections={hasUsableConnections}
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
                  connectionLabel={chatConnectionLabel}
                  modelLabel={chatModelLabel}
                  connected={chatConnected}
                  simulatedIds={simulatedIds}
                  error={agent.lastError}
                  onDismissError={agent.clearError}
                  lastMeta={agent.lastMeta}
                  streamingText={agent.streamingText}
                  isStreaming={agent.isStreaming}
                  activity={agent.activity}
                  toolEvents={agent.toolEvents}
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
            preview={preview}
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
          // Refresh connections so the toolbar picks up any changes made in
          // Settings (new connection, edited model, new default, etc.).
          void connections.refresh();
        }}
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
