import { useState, useCallback, useRef, useEffect } from 'react';
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderPlus,
  FilePlus,
  Pencil,
  Trash2,
  RefreshCw,
  FileCode2,
  FileJson,
  FileText,
  Hash,
  MoreVertical,
} from 'lucide-react';
import type { FileNode } from '@/types';

interface Props {
  nodes: FileNode[];
  loading: boolean;
  error: string | null;
  activePath: string | null;
  onOpenFile: (node: FileNode) => void;
  onCreateFile: (parentDir: string) => void;
  onCreateDir: (parentDir: string) => void;
  onRename: (node: FileNode) => void;
  onDelete: (node: FileNode) => void;
  onRefresh: () => void;
  onExpandFolder: (folderPath: string) => void;
}

function fileIcon(name: string) {
  if (name.endsWith('.json')) return <FileJson size={14} className="text-warning-500" />;
  if (name.endsWith('.md')) return <FileText size={14} className="text-surface-300" />;
  if (name.endsWith('.css')) return <Hash size={14} className="text-accent-400" />;
  return <FileCode2 size={14} className="text-accent-400" />;
}

interface MenuState {
  node: FileNode;
  x: number;
  y: number;
}

function TreeItem({
  node,
  depth,
  activePath,
  onOpenFile,
  onCreateFile,
  onCreateDir,
  onRename,
  onDelete,
  onContextMenu,
  onExpandFolder,
}: {
  node: FileNode;
  depth: number;
  activePath: string | null;
  onOpenFile: (n: FileNode) => void;
  onCreateFile: (parentDir: string) => void;
  onCreateDir: (parentDir: string) => void;
  onRename: (n: FileNode) => void;
  onDelete: (n: FileNode) => void;
  onContextMenu: (m: MenuState) => void;
  onExpandFolder: (folderPath: string) => void;
}) {
  const [open, setOpen] = useState(depth < 1);
  const isFolder = node.type === 'folder';
  const isActive = activePath === node.id;
  const needsLazyLoad = isFolder && open && node.children == null;

  useEffect(() => {
    if (needsLazyLoad) {
      console.log('[WORKSPACE-DEBUG] folder_expand', {
        folderPath: node.id,
        childrenState: node.children,
        depth,
      });
      onExpandFolder(node.id);
    }
  }, [needsLazyLoad, node.id, node.children, onExpandFolder, depth]);

  const handleClick = useCallback(() => {
    if (isFolder) {
      console.log('[WORKSPACE-DEBUG] folder_click', {
        folderPath: node.id,
        childrenState: node.children,
        currentlyOpen: open,
      });
      setOpen((o) => !o);
    } else {
      onOpenFile(node);
    }
  }, [isFolder, node, onOpenFile, open]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      onContextMenu({ node, x: e.clientX, y: e.clientY });
    },
    [node, onContextMenu],
  );

  return (
    <div>
      <div
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        className={`group flex w-full cursor-pointer items-center gap-1 rounded px-1.5 py-[3px] text-left text-2xs transition-colors hover:bg-surface-750 ${
          isActive ? 'bg-accent-500/10' : ''
        }`}
        style={{ paddingLeft: depth * 12 + 6 }}
      >
        {isFolder ? (
          <>
            {open ? (
              <ChevronDown size={12} className="shrink-0 text-surface-300" />
            ) : (
              <ChevronRight size={12} className="shrink-0 text-surface-300" />
            )}
            <Folder size={14} className="shrink-0 text-accent-400/80" fill="currentColor" fillOpacity={0.15} />
          </>
        ) : (
          <>
            <span className="w-3 shrink-0" />
            {fileIcon(node.name)}
          </>
        )}
        <span className="truncate font-mono text-[11px] text-gray-300 group-hover:text-gray-100">
          {node.name}
        </span>
      </div>
      {isFolder && open && (
        <div>
          {node.children == null ? (
            <div className="flex items-center gap-1 px-1.5 py-[3px] text-2xs text-surface-400" style={{ paddingLeft: (depth + 1) * 12 + 6 }}>
              <RefreshCw size={10} className="animate-spin" />
              Loading…
            </div>
          ) : node.children.length === 0 ? (
            <div className="px-1.5 py-[3px] text-2xs text-surface-400" style={{ paddingLeft: (depth + 1) * 12 + 6 }}>
              Empty folder
            </div>
          ) : (
            node.children.map((child) => (
              <TreeItem
                key={child.id}
                node={child}
                depth={depth + 1}
                activePath={activePath}
                onOpenFile={onOpenFile}
                onCreateFile={onCreateFile}
                onCreateDir={onCreateDir}
                onRename={onRename}
                onDelete={onDelete}
                onContextMenu={onContextMenu}
                onExpandFolder={onExpandFolder}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function ProjectExplorer({
  nodes,
  loading,
  error,
  activePath,
  onOpenFile,
  onCreateFile,
  onCreateDir,
  onRename,
  onDelete,
  onRefresh,
  onExpandFolder,
}: Props) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenu(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menu]);

  const handleCreateFile = useCallback(() => {
    if (!menu) return;
    const parent = menu.node.type === 'folder' ? menu.node.id : menu.node.id.split('/').slice(0, -1).join('/');
    onCreateFile(parent);
    setMenu(null);
  }, [menu, onCreateFile]);

  const handleCreateDir = useCallback(() => {
    if (!menu) return;
    const parent = menu.node.type === 'folder' ? menu.node.id : menu.node.id.split('/').slice(0, -1).join('/');
    onCreateDir(parent);
    setMenu(null);
  }, [menu, onCreateDir]);

  const handleRename = useCallback(() => {
    if (!menu) return;
    onRename(menu.node);
    setMenu(null);
  }, [menu, onRename]);

  const handleDelete = useCallback(() => {
    if (!menu) return;
    onDelete(menu.node);
    setMenu(null);
  }, [menu, onDelete]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-3 py-4 text-2xs text-surface-400">
        <RefreshCw size={12} className="animate-spin" />
        Loading files…
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-3 py-4 text-2xs text-error-400">
        {error}
        <button onClick={onRefresh} className="ml-2 text-accent-400 hover:underline">
          Retry
        </button>
      </div>
    );
  }

  if (nodes.length === 0) {
    return (
      <div className="px-3 py-4 text-2xs text-surface-400">
        No files. Import or create a project to get started.
      </div>
    );
  }

  return (
    <div className="py-1">
      {/* Toolbar */}
      <div className="mb-1 flex items-center gap-1 border-b border-surface-800 px-2 pb-1">
        <button
          onClick={() => onCreateFile('')}
          className="rounded p-1 text-surface-400 transition-colors hover:bg-surface-750 hover:text-accent-400"
          title="New file"
        >
          <FilePlus size={13} />
        </button>
        <button
          onClick={() => onCreateDir('')}
          className="rounded p-1 text-surface-400 transition-colors hover:bg-surface-750 hover:text-accent-400"
          title="New folder"
        >
          <FolderPlus size={13} />
        </button>
        <button
          onClick={onRefresh}
          className="rounded p-1 text-surface-400 transition-colors hover:bg-surface-750 hover:text-accent-400"
          title="Refresh"
        >
          <RefreshCw size={13} />
        </button>
      </div>

      {nodes.map((node) => (
        <TreeItem
          key={node.id}
          node={node}
          depth={0}
          activePath={activePath}
          onOpenFile={onOpenFile}
          onCreateFile={onCreateFile}
          onCreateDir={onCreateDir}
          onRename={onRename}
          onDelete={onDelete}
          onContextMenu={setMenu}
          onExpandFolder={onExpandFolder}
        />
      ))}

      {/* Context menu */}
      {menu && (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[140px] rounded-md border border-surface-600 bg-surface-850 py-1 text-2xs shadow-xl"
          style={{ left: menu.x, top: menu.y }}
        >
          {menu.node.type === 'folder' && (
            <>
              <button
                onClick={handleCreateFile}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-surface-300 hover:bg-surface-750 hover:text-gray-100"
              >
                <FilePlus size={12} /> New file
              </button>
              <button
                onClick={handleCreateDir}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-surface-300 hover:bg-surface-750 hover:text-gray-100"
              >
                <FolderPlus size={12} /> New folder
              </button>
            </>
          )}
          <button
            onClick={handleRename}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-surface-300 hover:bg-surface-750 hover:text-gray-100"
          >
            <Pencil size={12} /> Rename
          </button>
          <button
            onClick={handleDelete}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-error-400 hover:bg-error-500/10"
          >
            <Trash2 size={12} /> Delete
          </button>
        </div>
      )}
    </div>
  );
}
