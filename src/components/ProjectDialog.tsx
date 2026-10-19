import { useState } from 'react';
import { Folder, FileCode2, GitBranch, Rocket, FolderOpen } from 'lucide-react';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';

interface Props {
  open: boolean;
  mode: 'open' | 'new';
  onClose: () => void;
  onConfirm: (name: string) => void;
}

const templates = [
  { id: 'react', name: 'React + TypeScript', desc: 'Vite-powered SPA' },
  { id: 'next', name: 'Next.js App', desc: 'Full-stack framework' },
  { id: 'api', name: 'Node API', desc: 'Express + REST' },
  { id: 'blank', name: 'Blank', desc: 'Start from scratch' },
];

const recent = ['personal-ai-ide', 'landing-page', 'api-server', 'portfolio-site'];

export function ProjectDialog({ open, mode, onClose, onConfirm }: Props) {
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  const isNew = mode === 'new';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={isNew ? 'Create New Project' : 'Open Project'}
      description={isNew ? 'Pick a template and name your project.' : 'Choose a recent project or browse to open one.'}
      width="max-w-xl"
      footer={
        <>
          <Button variant="ghost" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="md"
            disabled={isNew ? !name.trim() : !selected}
            onClick={() => {
              onConfirm(isNew ? name.trim() : (selected as string));
              setName('');
              setSelected(null);
            }}
          >
            {isNew ? 'Create' : 'Open'}
          </Button>
        </>
      }
    >
      {isNew ? (
        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-2xs font-medium uppercase tracking-wider text-surface-300">
              Project name
            </label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-awesome-project"
              className="w-full rounded-md border border-surface-600 bg-surface-800 px-3 py-2 font-mono text-xs text-gray-100 placeholder:text-surface-400 focus:border-accent-500/50 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-2xs font-medium uppercase tracking-wider text-surface-300">
              Template
            </label>
            <div className="grid grid-cols-2 gap-2">
              {templates.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setSelected(t.id)}
                  className={`flex items-start gap-2.5 rounded-lg border p-3 text-left transition-all ${
                    selected === t.id
                      ? 'border-accent-500/50 bg-accent-500/5'
                      : 'border-surface-700 bg-surface-800 hover:border-surface-600'
                  }`}
                >
                  <FileCode2 size={16} className={selected === t.id ? 'text-accent-400' : 'text-surface-300'} />
                  <div>
                    <div className="text-xs font-medium text-gray-100">{t.name}</div>
                    <div className="mt-0.5 text-2xs text-surface-300">{t.desc}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-2 rounded-lg border border-surface-700 bg-surface-800 px-3 py-2">
            <FolderOpen size={15} className="text-surface-300" />
            <input
              autoFocus
              placeholder="Search recent projects..."
              className="flex-1 bg-transparent text-xs text-gray-100 placeholder:text-surface-400 focus:outline-none"
            />
          </div>
          <div className="space-y-1">
            {recent.map((r) => (
              <button
                key={r}
                onClick={() => setSelected(r)}
                className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors ${
                  selected === r ? 'bg-accent-500/10 text-gray-100' : 'text-surface-300 hover:bg-surface-800'
                }`}
              >
                <Folder size={15} className={selected === r ? 'text-accent-400' : 'text-surface-400'} />
                <span className="flex-1 truncate font-mono text-xs">{r}</span>
                <GitBranch size={12} className="text-surface-400" />
                <span className="text-2xs text-surface-400">main</span>
              </button>
            ))}
          </div>
          <button className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-surface-600 py-2.5 text-2xs text-surface-300 transition-colors hover:border-surface-500 hover:text-gray-200">
            <Rocket size={13} /> Browse folder from disk
          </button>
        </div>
      )}
    </Dialog>
  );
}
