import { useState } from 'react';
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FileCode2,
  FileJson,
  FileText,
  Hash,
} from 'lucide-react';
import type { FileNode } from '@/types';

interface Props {
  nodes: FileNode[];
  onOpenFile: (node: FileNode) => void;
}

function fileIcon(name: string) {
  if (name.endsWith('.json')) return <FileJson size={14} className="text-warning-500" />;
  if (name.endsWith('.md')) return <FileText size={14} className="text-surface-300" />;
  if (name.endsWith('.css')) return <Hash size={14} className="text-accent-400" />;
  return <FileCode2 size={14} className="text-accent-400" />;
}

function TreeItem({ node, depth, onOpenFile }: { node: FileNode; depth: number; onOpenFile: (n: FileNode) => void }) {
  const [open, setOpen] = useState(depth < 1);
  const isFolder = node.type === 'folder';

  return (
    <div>
      <button
        onClick={() => (isFolder ? setOpen((o) => !o) : onOpenFile(node))}
        className="group flex w-full items-center gap-1 rounded px-1.5 py-[3px] text-left text-2xs transition-colors hover:bg-surface-750"
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
      </button>
      {isFolder && open && node.children && (
        <div>
          {node.children.map((child) => (
            <TreeItem key={child.id} node={child} depth={depth + 1} onOpenFile={onOpenFile} />
          ))}
        </div>
      )}
    </div>
  );
}

export function ProjectExplorer({ nodes, onOpenFile }: Props) {
  return (
    <div className="py-1">
      {nodes.map((node) => (
        <TreeItem key={node.id} node={node} depth={0} onOpenFile={onOpenFile} />
      ))}
    </div>
  );
}
