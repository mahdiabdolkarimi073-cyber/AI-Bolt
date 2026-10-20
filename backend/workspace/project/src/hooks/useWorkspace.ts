import { useState, useCallback, useEffect, useRef } from 'react';
import { workspaceService } from '@/services/workspace';
import { getRepositories } from '@/services/index';
import type { FileNode } from '@/types';
import type { Project } from '@/types/domain';
import { ApiErrorClass } from '@/lib/errors';

export interface OpenFileTab {
  id: string;
  name: string;
  path: string;
  language: string;
  dirty: boolean;
  /** Original content loaded from disk (for dirty comparison). */
  original: string;
  /** Current edited content. */
  content: string;
  /** True if the file failed to load (binary, missing, too large). */
  error?: string;
}

export interface WorkspaceState {
  projects: Project[];
  activeProject: Project | null;
  tree: FileNode[];
  treeLoading: boolean;
  treeError: string | null;
  tabs: OpenFileTab[];
  activeTabId: string | null;
  busy: boolean;
  error: string | null;
}

export function useWorkspace() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [tree, setTree] = useState<FileNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [tabs, setTabs] = useState<OpenFileTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeProjectRef = useRef<Project | null>(null);
  activeProjectRef.current = activeProject;

  const refreshProjects = useCallback(async () => {
    try {
      const repos = getRepositories();
      const list = await repos.projects.list();
      setProjects(list);
      return list;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load projects');
      return [];
    }
  }, []);

  const loadTree = useCallback(async (project: Project) => {
    if (!project.workspacePath) {
      setTree([]);
      setTreeError('Project has no on-disk workspace.');
      return;
    }
    setTreeLoading(true);
    setTreeError(null);
    try {
      const nodes = await workspaceService.listTree(project.id, '', 2);
      setTree(nodes);
    } catch (e) {
      const msg = e instanceof ApiErrorClass ? e.message : 'Failed to load file tree';
      setTreeError(msg);
      setTree([]);
    } finally {
      setTreeLoading(false);
    }
  }, []);

  const openProject = useCallback(
    async (project: Project) => {
      setActiveProject(project);
      setTabs([]);
      setActiveTabId(null);
      await loadTree(project);
      try {
        const repos = getRepositories();
        await repos.settings.update({ activeProjectId: project.id });
      } catch {
        // non-fatal
      }
    },
    [loadTree],
  );

  const openFile = useCallback(async (node: FileNode) => {
    if (node.type !== 'file' || !activeProjectRef.current) return;
    const projectId = activeProjectRef.current.id;

    // If already open, activate it.
    const existing = tabs.find((t) => t.path === node.id);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }

    const tabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const newTab: OpenFileTab = {
      id: tabId,
      name: node.name,
      path: node.id,
      language: node.language ?? 'text',
      dirty: false,
      original: '',
      content: '',
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(tabId);

    try {
      const file = await workspaceService.readFile(projectId, node.id);
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tabId
            ? { ...t, content: file.content, original: file.content, language: file.language, error: undefined }
            : t,
        ),
      );
    } catch (e) {
      const msg = e instanceof ApiErrorClass ? e.message : 'Failed to load file';
      setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, error: msg } : t)));
    }
  }, [tabs]);

  const closeTab = useCallback(
    (id: string, force = false) => {
      const tab = tabs.find((t) => t.id === id);
      if (!tab) return;
      if (tab.dirty && !force) {
        // Caller should confirm before calling with force=true.
        return 'dirty';
      }
      setTabs((prev) => {
        const next = prev.filter((t) => t.id !== id);
        if (activeTabId === id) {
          setActiveTabId(next[next.length - 1]?.id ?? null);
        }
        return next;
      });
      return undefined;
    },
    [tabs, activeTabId],
  );

  const updateTabContent = useCallback((id: string, content: string) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.id === id ? { ...t, content, dirty: content !== t.original } : t,
      ),
    );
  }, []);

  const saveTab = useCallback(
    async (id: string): Promise<boolean> => {
      const tab = tabs.find((t) => t.id === id);
      if (!tab || !activeProjectRef.current) return false;
      setBusy(true);
      try {
        await workspaceService.writeFile(
          activeProjectRef.current.id,
          tab.path,
          tab.content,
          { overwrite: true },
        );
        setTabs((prev) =>
          prev.map((t) => (t.id === id ? { ...t, original: t.content, dirty: false } : t)),
        );
        return true;
      } catch (e) {
        setError(e instanceof ApiErrorClass ? e.message : 'Save failed');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [tabs],
  );

  const refreshTree = useCallback(async () => {
    if (activeProjectRef.current) {
      await loadTree(activeProjectRef.current);
    }
  }, [loadTree]);

  const clearError = useCallback(() => setError(null), []);

  return {
    projects,
    activeProject,
    tree,
    treeLoading,
    treeError,
    tabs,
    activeTabId,
    busy,
    error,
    refreshProjects,
    openProject,
    loadTree,
    refreshTree,
    openFile,
    closeTab,
    updateTabContent,
    saveTab,
    setActiveTabId,
    setError,
    clearError,
  };
}
