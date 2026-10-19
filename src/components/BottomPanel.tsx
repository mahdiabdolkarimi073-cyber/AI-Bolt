import { useState } from 'react';
import {
  Terminal as TerminalIcon,
  AlertTriangle,
  Info,
  ScrollText,
  FlaskConical,
  ChevronDown,
  Trash2,
  X,
  CheckCircle2,
  MinusCircle,
} from 'lucide-react';
import type { BottomTab } from '@/types';
import { sampleTerminalLines, sampleProblems, sampleOutput, sampleTests } from '@/data/mock';

interface Props {
  open: boolean;
  onToggle: () => void;
  activeTab: BottomTab;
  onTabChange: (t: BottomTab) => void;
}

const tabs: { id: BottomTab; label: string; icon: typeof TerminalIcon; badge?: number }[] = [
  { id: 'terminal', label: 'Terminal', icon: TerminalIcon },
  { id: 'problems', label: 'Problems', icon: AlertTriangle, badge: sampleProblems.length },
  { id: 'output', label: 'Output', icon: ScrollText },
  { id: 'tests', label: 'Tests', icon: FlaskConical },
];

export function BottomPanel({ open, onToggle, activeTab, onTabChange }: Props) {
  return (
    <div className="flex shrink-0 flex-col border-t border-surface-700 bg-surface-900" style={{ height: open ? 200 : 32 }}>
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
                {t.badge ? (
                  <span className="ml-0.5 rounded-full bg-surface-700 px-1.5 text-[10px] text-surface-300">{t.badge}</span>
                ) : null}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-0.5">
          <button
            className="rounded p-1 text-surface-300 transition-colors hover:bg-surface-750 hover:text-gray-100"
            aria-label="Clear"
            title="Clear"
          >
            <Trash2 size={13} />
          </button>
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
        <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
          {activeTab === 'terminal' && <TerminalView />}
          {activeTab === 'problems' && <ProblemsView />}
          {activeTab === 'output' && <OutputView />}
          {activeTab === 'tests' && <TestsView />}
        </div>
      )}
    </div>
  );
}

function TerminalView() {
  return (
    <div className="px-3 py-2 font-mono text-2xs leading-relaxed">
      {sampleTerminalLines.map((line, i) => (
        <div key={i} className="whitespace-pre text-gray-300">
          {line.startsWith('$') ? (
            <span>
              <span className="text-success-500">$</span>
              {line.slice(1)}
            </span>
          ) : (
            line || <span>&nbsp;</span>
          )}
        </div>
      ))}
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
            <Info size={13} className="shrink-0 text-accent-400" />
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
            <CheckCircle2 size={13} className="shrink-0 text-success-500" />
          ) : t.status === 'skip' ? (
            <MinusCircle size={13} className="shrink-0 text-surface-400" />
          ) : (
            <X size={13} className="shrink-0 text-error-400" />
          )}
          <span className="min-w-0 truncate text-gray-200">{t.name}</span>
          <span className="ml-auto shrink-0 font-mono text-surface-400">{t.time}</span>
        </div>
      ))}
    </div>
  );
}
