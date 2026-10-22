import {
  Terminal as TerminalIcon,
  AlertTriangle,
  ScrollText,
  FlaskConical,
  ChevronDown,
  X,
} from 'lucide-react';
import type { BottomTab } from '@/types';
import { sampleProblems, sampleOutput, sampleTests } from '@/data/mock';
import { TerminalPanel } from './TerminalPanel';
import type { UseTerminalResult } from '@/hooks/useTerminal';

interface Props {
  open: boolean;
  onToggle: () => void;
  activeTab: BottomTab;
  onTabChange: (t: BottomTab) => void;
  terminal: UseTerminalResult;
  height: number;
}

const tabs: { id: BottomTab; label: string; icon: typeof TerminalIcon; badge?: number }[] = [
  { id: 'terminal', label: 'Terminal', icon: TerminalIcon },
  { id: 'problems', label: 'Problems', icon: AlertTriangle, badge: sampleProblems.length },
  { id: 'output', label: 'Output', icon: ScrollText },
  { id: 'tests', label: 'Tests', icon: FlaskConical },
];

export function BottomPanel({ open, onToggle, activeTab, onTabChange, terminal, height }: Props) {
  return (
    <div className="flex shrink-0 flex-col border-t border-surface-700 bg-surface-900" style={{ height: open ? height : 32 }}>
      {/* tab bar */}
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-surface-800 pr-2">
        <div className="flex h-full items-stretch">
          {tabs.map((t) => {
            const Icon = t.icon;
            const active = activeTab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => {
                  onTabChange(t.id);
                  if (!open) onToggle();
                }}
                className={`relative flex items-center gap-1.5 px-3 text-2xs font-medium transition-colors ${
                  active && open
                    ? 'text-gray-100'
                    : 'text-surface-300 hover:text-gray-200'
                }`}
              >
                {active && open && <span className="absolute left-0 top-0 h-[2px] w-full bg-accent-500" />}
                <Icon size={13} />
                {t.label}
                {t.id === 'terminal' && terminal.sessions.length > 0 && (
                  <span className="ml-0.5 rounded-full bg-surface-700 px-1.5 text-[10px] text-surface-300">{terminal.sessions.length}</span>
                )}
                {t.badge ? (
                  <span className="ml-0.5 rounded-full bg-surface-700 px-1.5 text-[10px] text-surface-300">{t.badge}</span>
                ) : null}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-0.5">
          <button
            onClick={onToggle}
            className="rounded p-1 text-surface-300 transition-colors hover:bg-surface-750 hover:text-gray-100"
            aria-label={open ? 'Collapse panel' : 'Expand panel'}
            title={open ? 'Collapse' : 'Expand'}
          >
            {open ? <ChevronDown size={15} className="rotate-180" /> : <ChevronDown size={15} />}
          </button>
          <button
            onClick={onToggle}
            className="rounded p-1 text-surface-300 transition-colors hover:bg-surface-750 hover:text-gray-100"
            aria-label="Close panel"
            title="Close"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* content */}
      {open && (
        <div className="min-h-0 flex-1 overflow-hidden">
          {activeTab === 'terminal' && <TerminalPanel terminal={terminal} height={height - 32} />}
          {activeTab === 'problems' && (
            <div className="h-full overflow-auto scrollbar-thin">
              <ProblemsView />
            </div>
          )}
          {activeTab === 'output' && (
            <div className="h-full overflow-auto scrollbar-thin">
              <OutputView />
            </div>
          )}
          {activeTab === 'tests' && (
            <div className="h-full overflow-auto scrollbar-thin">
              <TestsView />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProblemsView() {
  return (
    <div className="px-2 py-1.5">
      {sampleProblems.map((p, i) => (
        <div key={i} className="flex items-center gap-2 rounded px-2 py-1 text-2xs hover:bg-surface-800">
          {p.severity === 'warning' ? (
            <AlertTriangle size={13} className="shrink-0 text-warning-500" />
          ) : (
            <ScrollText size={13} className="shrink-0 text-accent-400" />
          )}
          <span className="shrink-0 text-surface-300">{p.severity}</span>
          <span className="min-w-0 truncate text-gray-200">{p.message}</span>
          <span className="ml-auto shrink-0 font-mono text-surface-400">
            {p.file}:{p.line}:{p.col}
          </span>
        </div>
      ))}
    </div>
  );
}

function OutputView() {
  return (
    <div className="px-3 py-2 font-mono text-2xs leading-relaxed">
      {sampleOutput.map((line, i) => {
        const color = line.startsWith('[success]')
          ? 'text-success-500'
          : line.startsWith('[error]')
          ? 'text-error-400'
          : 'text-surface-300';
        return (
          <div key={i} className={color}>
            {line}
          </div>
        );
      })}
    </div>
  );
}

function TestsView() {
  return (
    <div className="px-2 py-1.5">
      {sampleTests.map((t, i) => (
        <div key={i} className="flex items-center gap-2 rounded px-2 py-1 text-2xs hover:bg-surface-800">
          {t.status === 'pass' ? (
            <FlaskConical size={13} className="shrink-0 text-success-500" />
          ) : (
            <FlaskConical size={13} className="shrink-0 text-error-400" />
          )}
          <span className="min-w-0 truncate text-gray-200">{t.name}</span>
          <span className="ml-auto shrink-0 font-mono text-surface-400">{t.time}</span>
        </div>
      ))}
    </div>
  );
}
