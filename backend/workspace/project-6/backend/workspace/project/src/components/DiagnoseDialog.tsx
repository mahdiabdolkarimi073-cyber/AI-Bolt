import { useState } from 'react';
import { Sparkles, AlertCircle, Check, FileEdit } from 'lucide-react';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import type { ProposedChange } from '@/types/execution';

interface Props {
  open: boolean;
  analysis: string;
  changes: ProposedChange[];
  busy?: boolean;
  applying?: boolean;
  onApply: (changes: ProposedChange[]) => Promise<void>;
  onRerun?: () => void;
  onClose: () => void;
}

/** Review AI-proposed code fixes before applying them. Each change shows a
 * simple before/after diff. Nothing is written until the user approves. */
export function DiagnoseDialog({ open, analysis, changes, busy, applying, onApply, onRerun, onClose }: Props) {
  const [selected, setSelected] = useState<Set<number>>(new Set(changes.map((_, i) => i)));
  const [applied, setApplied] = useState(false);

  // Keep selection in sync when the change set changes.
  if (open && selected.size !== changes.length && !applied) {
    setSelected(new Set(changes.map((_, i) => i)));
  }

  const toggle = (i: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  const handleApply = async () => {
    const chosen = changes.filter((_, i) => selected.has(i));
    if (chosen.length === 0) return;
    await onApply(chosen);
    setApplied(true);
  };

  const handleClose = () => {
    setApplied(false);
    setSelected(new Set(changes.map((_, i) => i)));
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title="AI error diagnosis"
      description="Review the proposed fixes before applying anything. Selected changes are written through the workspace file service."
      width="max-w-3xl"
      footer={
        <>
          <Button variant="ghost" size="md" onClick={handleClose}>
            {applied ? 'Close' : 'Cancel'}
          </Button>
          {!applied && changes.length > 0 && (
            <Button variant="primary" size="md" onClick={handleApply} disabled={applying || selected.size === 0}>
              {applying ? 'Applying…' : `Apply ${selected.size} change${selected.size === 1 ? '' : 's'}`}
            </Button>
          )}
          {applied && onRerun && (
            <Button variant="secondary" size="md" onClick={onRerun}>
              <Sparkles size={14} /> Re-run command
            </Button>
          )}
        </>
      }
    >
      {busy ? (
        <div className="flex items-center gap-2 py-6 text-xs text-surface-300">
          <Sparkles size={16} className="animate-pulse text-accent-400" />
          Analyzing the error with the configured AI connection…
        </div>
      ) : (
        <div className="space-y-3">
          <div className="rounded-lg border border-surface-700 bg-surface-800/60 px-3 py-2.5">
            <div className="mb-1 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wide text-accent-400">
              <AlertCircle size={12} /> Analysis
            </div>
            <p className="whitespace-pre-wrap text-xs leading-relaxed text-gray-200">{analysis}</p>
          </div>

          {changes.length === 0 ? (
            <div className="rounded-lg border border-surface-700 bg-surface-800/40 px-3 py-3 text-xs text-surface-300">
              No specific code changes were proposed. The analysis above may still point you toward a
              manual fix, or the AI could not diagnose the error confidently.
            </div>
          ) : (
            <div className="space-y-2">
              {changes.map((c, i) => (
                <ChangeCard
                  key={`${c.path}-${i}`}
                  change={c}
                  selected={selected.has(i)}
                  applied={applied}
                  onToggle={() => toggle(i)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

function ChangeCard({
  change,
  selected,
  applied,
  onToggle,
}: {
  change: ProposedChange;
  selected: boolean;
  applied: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className={`rounded-lg border px-3 py-2.5 transition-colors ${
        applied ? 'border-success-500/40 bg-success-500/5' : selected ? 'border-accent-500/40 bg-accent-500/5' : 'border-surface-700 bg-surface-800/40'
      }`}
    >
      <div className="flex items-start gap-2">
        {!applied && (
          <button
            onClick={onToggle}
            className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
              selected ? 'border-accent-500 bg-accent-500 text-white' : 'border-surface-600 text-transparent hover:border-surface-500'
            }`}
            aria-label={selected ? 'Deselect change' : 'Select change'}
          >
            {selected && <Check size={11} />}
          </button>
        )}
        {applied && <Check size={14} className="mt-0.5 shrink-0 text-success-500" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-xs font-medium text-gray-100">
            <FileEdit size={13} className="text-surface-300" />
            <span className="font-mono">{change.path}</span>
          </div>
          {change.description && (
            <p className="mt-1 text-2xs text-surface-300">{change.description}</p>
          )}
          <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
            <DiffBlock label="Original" tone="remove" text={change.original} />
            <DiffBlock label="Updated" tone="add" text={change.updated} />
          </div>
        </div>
      </div>
    </div>
  );
}

function DiffBlock({ label, tone, text }: { label: string; tone: 'add' | 'remove'; text: string }) {
  const color = tone === 'add' ? 'text-success-400' : 'text-error-400';
  const bg = tone === 'add' ? 'bg-success-500/5 border-success-500/20' : 'bg-error-500/5 border-error-500/20';
  return (
    <div className={`rounded border ${bg} px-2 py-1.5`}>
      <div className={`mb-1 text-[10px] font-semibold uppercase tracking-wide ${color}`}>{label}</div>
      <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-gray-300 scrollbar-thin">
        {text || <span className="text-surface-400">(empty)</span>}
      </pre>
    </div>
  );
}
