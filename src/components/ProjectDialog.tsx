import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Folder,
  FileCode2,
  GitBranch,
  Rocket,
  FolderOpen,
  Upload,
  FilePlus,
  Trash2,
  Loader2,
  AlertCircle,
  X,
} from 'lucide-react';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import { workspaceService } from '@/services/workspace';
import { getRepositories } from '@/services/index';
import type { Project } from '@/types/domain';

interface Props {
  open: boolean;
  mode: 'open' | 'new';
  onClose: () => void;
  onProjectOpened: (project: Project) => void;
  onProjectCreated: (project: Project) => void;
}

type ImportPhase = 'idle' | 'uploading' | 'extracting' | 'done' | 'error';

export function ProjectDialog({ open, mode, onClose, onProjectOpened, onProjectCreated }: Props) {
  const [name, setName] = useState('');
  const [recentProjects, setRecentProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadingRecent, setLoadingRecent] = useState(false);
  const [importPhase, setImportPhase] = useState<ImportPhase>('idle');
  const [importError, setImportError] = useState<string | null>(null);
  const [importName, setImportName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const selectedFileRef = useRef<File | null>(null);

  const isNew = mode === 'new';

  const loadRecent = useCallback(async () => {
    setLoadingRecent(true);
    setError(null);
    try {
      const repos = getRepositories();
      const list = await repos.projects.list();
      setRecentProjects(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load projects');
    } finally {
      setLoadingRecent(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setImportPhase('idle');
      setImportError(null);
      setImportName('');
      setError(null);
      setName('');
      setSelectedId(null);
      selectedFileRef.current = null;
      loadRecent();
    }
  }, [open, loadRecent]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    selectedFileRef.current = file;
    const baseName = file.name.replace(/\.zip$/i, '');
    setImportName(baseName);
    setImportError(null);
    setImportPhase('idle');
  }, []);

  const handleImport = useCallback(async () => {
    const file = selectedFileRef.current;
    if (!file) {
      setImportError('Choose a ZIP file first.');
      return;
    }
    setImportPhase('uploading');
    setImportError(null);
    try {
      const project = await workspaceService.importZip(file, importName.trim() || undefined);
      setImportPhase('done');
      onProjectCreated(project);
      onClose();
    } catch (e) {
      setImportPhase('error');
      setImportError(e instanceof Error ? e.message : 'Import failed');
    }
  }, [importName, onProjectCreated, onClose]);

  const handleCreateEmpty = useCallback(async () => {
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const project = await workspaceService.createEmptyProject(name.trim());
      onProjectCreated(project);
      setName('');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create project');
    } finally {
      setCreating(false);
    }
  }, [name, onProjectCreated, onClose]);

  const handleOpenSelected = useCallback(async () => {
    if (!selectedId) return;
    const project = recentProjects.find((p) => p.id === selectedId);
    if (project) {
      onProjectOpened(project);
      onClose();
    }
  }, [selectedId, recentProjects, onProjectOpened, onClose]);

  const handleRemoveFromRecent = useCallback(
    async (e: React.MouseEvent, pid: string) => {
      e.stopPropagation();
      try {
        await workspaceService.removeFromRecent(pid);
        setRecentProjects((prev) => prev.filter((p) => p.id !== pid));
        if (selectedId === pid) setSelectedId(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to remove from recent');
      }
    },
    [selectedId],
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={isNew ? 'Create or Import Project' : 'Open Project'}
      description={
        isNew
          ? 'Import a ZIP archive or create an empty project.'
          : 'Choose a recent project to open.'
      }
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" size="md" onClick={onClose}>
            Cancel
          </Button>
          {isNew ? (
            <Button
              variant="primary"
              size="md"
              disabled={importPhase === 'uploading' || creating || (!selectedFileRef.current && !name.trim())}
              onClick={selectedFileRef.current ? handleImport : handleCreateEmpty}
            >
              {importPhase === 'uploading' ? 'Importing…' : selectedFileRef.current ? 'Import ZIP' : 'Create Project'}
            </Button>
          ) : (
            <Button variant="primary" size="md" disabled={!selectedId} onClick={handleOpenSelected}>
              Open
            </Button>
          )}
        </>
      }
    >
      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-error-500/30 bg-error-500/5 px-3 py-2 text-xs text-error-400">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-error-400 hover:text-error-300">
            <X size={14} />
          </button>
        </div>
      )}

      {isNew ? (
        <div className="space-y-5">
          {/* Import from ZIP */}
          <div className="rounded-lg border border-surface-700 bg-surface-800 p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium text-gray-100">
              <Upload size={15} className="text-accent-400" />
              Import from ZIP archive
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip,application/zip"
              onChange={handleFileSelect}
              className="hidden"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-surface-600 py-3 text-2xs text-surface-300 transition-colors hover:border-accent-500/50 hover:text-accent-400"
            >
              <FolderOpen size={14} />
              {selectedFileRef.current ? selectedFileRef.current.name : 'Choose a .zip file…'}
            </button>
            {selectedFileRef.current && (
              <div className="mt-3">
                <label className="mb-1.5 block text-2xs font-medium uppercase tracking-wider text-surface-300">
                  Project name
                </label>
                <input
                  value={importName}
                  onChange={(e) => setImportName(e.target.value)}
                  placeholder="my-project"
                  className="w-full rounded-md border border-surface-600 bg-surface-850 px-3 py-2 font-mono text-xs text-gray-100 placeholder:text-surface-400 focus:border-accent-500/50 focus:outline-none"
                />
              </div>
            )}
            {importPhase === 'uploading' && (
              <div className="mt-3 flex items-center gap-2 text-2xs text-accent-400">
                <Loader2 size={13} className="animate-spin" />
                Extracting and validating archive…
              </div>
            )}
            {importError && (
              <div className="mt-3 flex items-start gap-2 rounded-md border border-error-500/30 bg-error-500/5 px-3 py-2 text-2xs text-error-400">
                <AlertCircle size={13} className="mt-0.5 shrink-0" />
                <span className="flex-1">{importError}</span>
              </div>
            )}
            <p className="mt-3 text-2xs text-surface-400">
              Archives are validated for ZIP-slip, symlinks, and size limits before extraction.
            </p>
          </div>

          {/* Create empty */}
          <div className="rounded-lg border border-surface-700 bg-surface-800 p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium text-gray-100">
              <FilePlus size={15} className="text-success-400" />
              Create an empty project
            </div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-awesome-project"
              className="w-full rounded-md border border-surface-600 bg-surface-850 px-3 py-2 font-mono text-xs text-gray-100 placeholder:text-surface-400 focus:border-accent-500/50 focus:outline-none"
            />
            {creating && (
              <div className="mt-2 flex items-center gap-2 text-2xs text-success-400">
                <Loader2 size={13} className="animate-spin" />
                Creating…
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-2 rounded-lg border border-surface-700 bg-surface-800 px-3 py-2">
            <FolderOpen size={15} className="text-surface-300" />
            <span className="text-2xs text-surface-400">
              {loadingRecent ? 'Loading…' : `${recentProjects.length} project(s) registered`}
            </span>
          </div>
          <div className="max-h-80 space-y-1 overflow-y-auto scrollbar-thin">
            {recentProjects.length === 0 && !loadingRecent ? (
              <div className="py-8 text-center text-2xs text-surface-400">
                No projects yet. Create or import one to get started.
              </div>
            ) : (
              recentProjects.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setSelectedId(r.id)}
                  className={`group flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors ${
                    selectedId === r.id ? 'bg-accent-500/10 text-gray-100' : 'text-surface-300 hover:bg-surface-800'
                  }`}
                >
                  <Folder size={15} className={selectedId === r.id ? 'text-accent-400' : 'text-surface-400'} />
                  <span className="flex-1 truncate font-mono text-xs">{r.name}</span>
                  {r.workspacePath ? (
                    <span className="text-2xs text-surface-400">{r.importSource ?? 'imported'}</span>
                  ) : (
                    <span className="text-2xs text-warning-500">no workspace</span>
                  )}
                  <button
                    onClick={(e) => handleRemoveFromRecent(e, r.id)}
                    className="text-surface-400 opacity-0 transition-opacity hover:text-error-400 group-hover:opacity-100"
                    title="Remove from recent (keeps files)"
                  >
                    <Trash2 size={12} />
                  </button>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
