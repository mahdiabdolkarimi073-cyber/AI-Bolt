import { FolderOpen, Sparkles, Rocket, FileCode2, BookOpen } from 'lucide-react';
import { Button } from './ui/Button';

interface Props {
  onOpenProject: () => void;
  onNewProject: () => void;
}

export function EmptyState({ onOpenProject, onNewProject }: Props) {
  const cards = [
    { icon: Rocket, title: 'Start from template', desc: 'Scaffold a React, Next.js, or API project in seconds.' },
    { icon: FileCode2, title: 'Open a file', desc: 'Browse an existing repository and start editing.' },
    { icon: BookOpen, title: 'Explore docs', desc: 'Ask the assistant to explain a library or concept.' },
  ];

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-surface-950 p-6">
      <div className="w-full max-w-2xl animate-slide-up text-center">
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-surface-700 bg-surface-850 shadow-panel">
          <Sparkles size={26} className="text-accent-400" />
        </div>
        <h1 className="text-xl font-semibold text-gray-100">Start building something great</h1>
        <p className="mx-auto mt-2 max-w-md text-sm text-surface-300">
          Open an existing project or create a new one. Your AI assistant is ready to help you write, refactor, and ship.
        </p>
        <div className="mt-6 flex items-center justify-center gap-2.5">
          <Button variant="primary" onClick={onOpenProject}>
            <FolderOpen size={15} /> Open Project
          </Button>
          <Button variant="secondary" onClick={onNewProject}>
            <Sparkles size={15} /> Create New Project
          </Button>
        </div>

        <div className="mt-10 grid gap-3 text-left sm:grid-cols-3">
          {cards.map((c) => {
            const Icon = c.icon;
            return (
              <button
                key={c.title}
                onClick={onNewProject}
                className="group rounded-xl border border-surface-700 bg-surface-850 p-4 text-left transition-all hover:border-surface-600 hover:bg-surface-800"
              >
                <Icon size={18} className="text-accent-400 transition-transform group-hover:scale-110" />
                <h3 className="mt-3 text-xs font-semibold text-gray-100">{c.title}</h3>
                <p className="mt-1 text-2xs text-surface-300">{c.desc}</p>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
