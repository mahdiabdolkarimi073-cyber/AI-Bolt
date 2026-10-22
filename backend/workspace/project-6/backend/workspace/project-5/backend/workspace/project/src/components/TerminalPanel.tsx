import { useEffect, useRef, useState } from 'react';
import {
  Terminal as TerminalIcon,
  X,
  Trash2,
  Square,
  RotateCw,
  Play,
  AlertTriangle,
  Loader2,
  CheckCircle2,
  ExternalLink,
  ShieldAlert,
  FlaskConical,
  Hammer,
  Zap,
} from 'lucide-react';
import type { UseTerminalResult } from '@/hooks/useTerminal';
import type { ExecSessionStatus, InferredCommand, TerminalLine } from '@/types/execution';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';

interface Props {
  terminal: UseTerminalResult;
  height: number;
}

const STATUS_META: Record<ExecSessionStatus, { label: string; color: string; icon?: typeof CheckCircle2 }> = {
  pending: { label: 'pending', color: 'text-surface-400', icon: Loader2 },
  running: { label: 'running', color: 'text-accent-400', icon: Loader2 },
  completed: { label: 'done', color: 'text-success-500', icon: CheckCircle2 },
  failed: { label: 'failed', color: 'text-error-400', icon: AlertTriangle },
  stopped: { label: 'stopped', color: 'text-warning-500', icon: Square },
  timeout: { label: 'timeout', color: 'text-warning-500', icon: AlertTriangle },
};

export function TerminalPanel({ terminal, height }: Props) {
  const [input, setInput] = useState('');
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const active = terminal.activeSession;

  // Auto-scroll to bottom on new output.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [active?.lines.length]);

  const submit = async () => {
    const cmd = input.trim();
    if (!cmd) return;
    setInput('');
    setHistoryIdx(null);
    await terminal.runCommand({ command: cmd, kind: 'command', source: 'user' });
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      void submit();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (terminal.history.length === 0) return;
      const next = historyIdx === null ? 0 : Math.min(historyIdx + 1, terminal.history.length - 1);
      setHistoryIdx(next);
      setInput(terminal.history[next] ?? '');
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIdx === null) return;
      const next = historyIdx - 1;
      if (next < 0) {
        setHistoryIdx(null);
        setInput('');
      } else {
        setHistoryIdx(next);
        setInput(terminal.history[next] ?? '');
      }
    }
  };

  return (
    <div className="flex h-full flex-col bg-surface-900" style={{ height }}>
      {/* Session tabs */}
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-surface-800 pr-1.5">
        <div className="flex h-full items-stretch overflow-x-auto scrollbar-thin">
          {terminal.sessions.length === 0 && (
            <div className="flex items-center px-3 text-2xs text-surface-400">No active sessions</div>
          )}
          {terminal.sessions.map((s) => {
            const meta = STATUS_META[s.status];
            const Icon = meta.icon;
            const isActive = s.id === terminal.activeSessionId;
            const spin = s.status === 'running' || s.status === 'pending';
            return (
              <div
                key={s.id}
                onClick={() => terminal.selectSession(s.id)}
                className={`group flex cursor-pointer items-center gap-1.5 border-r border-surface-800 px-3 text-2xs font-medium transition-colors ${
                  isActive ? 'bg-surface-850 text-gray-100' : 'text-surface-300 hover:bg-surface-850/60 hover:text-gray-200'
                }`}
              >
                {Icon && <Icon size={11} className={`${meta.color} ${spin ? 'animate-spin' : ''}`} />}
                <span className="max-w-[180px] truncate font-mono">{labelForSession(s.command, s.kind)}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void terminal.closeSession(s.id);
                  }}
                  className="ml-1 rounded p-0.5 text-surface-400 opacity-0 transition-opacity hover:bg-surface-700 hover:text-gray-100 group-hover:opacity-100"
                  aria-label="Close session"
                >
                  <X size={11} />
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-0.5">

        </div>
      </div>

      {/* Runtime toolbar */}
      <RuntimeToolbar terminal={terminal} />

      {/* Output */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto scrollbar-thin px-2 py-1.5 font-mono text-2xs leading-relaxed">
        {!terminal.available ? (
          <UnavailableNotice />
        ) : !active ? (
          <EmptyNotice />
        ) : (
          active.lines.map((line) => <LineView key={line.id} line={line} />)
        )}
        {active && active.status === 'running' && (
          <div className="mt-1 inline-block h-3 w-1.5 animate-pulse bg-accent-400 align-middle" />
        )}
      </div>

      {/* Status bar + input */}
      <div className="shrink-0 border-t border-surface-800">
        {active && (
          <div className="flex items-center justify-between px-2 py-1 text-[10px] text-surface-400">
            <div className="flex items-center gap-2 truncate">
              <span className={`font-medium ${STATUS_META[active.status].color}`}>{STATUS_META[active.status].label}</span>
              <span className="truncate font-mono">{active.workingDir}</span>
              {active.exitCode != null && (
                <span className={active.exitCode === 0 ? 'text-success-500' : 'text-error-400'}>
                  exit {active.exitCode}
                </span>
              )}
              {active.previewUrl && (
                <a
                  href={active.previewUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-0.5 text-accent-400 hover:text-accent-300"
                >
                  <ExternalLink size={10} /> {active.previewUrl}
                </a>
              )}
            </div>
            <div className="flex items-center gap-1">
              {active.status === 'running' || active.status === 'pending' ? (
                <IconBtn title="Stop" onClick={() => terminal.stopSession(active.id)}>
                  <Square size={12} />
                </IconBtn>
              ) : (
                <IconBtn
                  title="Re-run"
                  onClick={() => terminal.runCommand({ command: active.command, kind: active.kind, source: active.source, longRunning: active.longRunning })}
                >
                  <RotateCw size={12} />
                </IconBtn>
              )}
              <IconBtn title="Clear output" onClick={() => terminal.clearOutput(active.id)}>
                <Trash2 size={12} />
              </IconBtn>
              {(active.status === 'failed' || active.status === 'timeout') && (
                <button
                  onClick={() => terminal.diagnose(active.id)}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-accent-300 transition-colors hover:bg-accent-500/10"
                  title="Analyze error with AI"
                >
                  <Zap size={11} /> Analyze
                </button>
              )}
            </div>
          </div>
        )}
        {terminal.available && (
          <div className="flex items-center gap-1.5 px-2 py-1.5">
            <span className="text-success-500">$</span>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKey}
              placeholder={terminal.activeSession ? 'Type a command and press Enter…' : 'Open a project to run commands'}
              className="flex-1 bg-transparent font-mono text-2xs text-gray-100 placeholder:text-surface-500 focus:outline-none"
              spellCheck={false}
              autoComplete="off"
              disabled={!terminal.available}
            />
          </div>
        )}
      </div>

      {/* Approval dialog */}
      <ApprovalDialog terminal={terminal} />
    </div>
  );
}

function RuntimeToolbar({ terminal }: { terminal: UseTerminalResult }) {
  if (!terminal.available) return null;
  const rt = terminal.runtime;
  if (!rt && terminal.detecting) {
    return (
      <div className="flex items-center gap-1.5 border-b border-surface-800 px-2 py-1 text-[10px] text-surface-400">
        <Loader2 size={11} className="animate-spin" /> Detecting project runtime…
      </div>
    );
  }
  if (!rt) {
    if (terminal.detectionError) {
      return (
        <div className="flex items-center gap-1.5 border-b border-surface-800 px-2 py-1 text-[10px] text-warning-500">
          <AlertTriangle size={11} /> {terminal.detectionError}
        </div>
      );
    }
    return null;
  }
  const quick = terminal.commands.filter((c) => c.available && (c.kind === 'run' || c.kind === 'test' || c.kind === 'build' || c.kind === 'typecheck' || c.kind === 'lint'));
  return (
    <div className="flex items-center gap-1.5 border-b border-surface-800 px-2 py-1 text-[10px]">
      <span className="font-medium text-surface-300">{rt.runtime}{rt.framework ? ` · ${rt.framework}` : ''}</span>
      {rt.packageManager && <span className="text-surface-400">{rt.packageManager}</span>}
      {rt.missingTools.length > 0 && (
        <span className="inline-flex items-center gap-0.5 text-warning-500" title={rt.missingTools.join(', ')}>
          <AlertTriangle size={10} /> missing: {rt.missingTools.slice(0, 3).join(', ')}
        </span>
      )}
      <div className="ml-auto flex items-center gap-0.5">
        {quick.slice(0, 5).map((c) => (
          <QuickBtn key={c.action} cmd={c} onClick={() => terminal.runCommand({ command: c.command ?? '', kind: c.kind, longRunning: c.longRunning, sensitive: c.sensitive, reason: c.reason })} />
        ))}
        {terminal.commands.some((c) => c.kind === 'deps' && c.available) && (
          <button
            onClick={() => {
              const dep = terminal.commands.find((c) => c.kind === 'deps');
              if (dep) terminal.runCommand({ command: dep.command ?? '', kind: 'deps', sensitive: true, reason: dep.reason });
            }}
            className="inline-flex items-center gap-1 rounded border border-surface-700 px-1.5 py-0.5 text-[10px] text-surface-300 transition-colors hover:bg-surface-750 hover:text-gray-100"
            title="Install dependencies (requires approval)"
          >
            <Hammer size={10} /> Install deps
          </button>
        )}
      </div>
    </div>
  );
}

function QuickBtn({ cmd, onClick }: { cmd: InferredCommand; onClick: () => void }) {
  const icon = cmd.kind === 'test' ? <FlaskConical size={10} /> : cmd.kind === 'build' ? <Hammer size={10} /> : <Play size={10} />;
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded border border-surface-700 px-1.5 py-0.5 text-[10px] text-surface-300 transition-colors hover:bg-surface-750 hover:text-gray-100"
      title={cmd.reason}
    >
      {icon} {cmd.action}
    </button>
  );
}

function LineView({ line }: { line: TerminalLine }) {
  if (line.stream === 'command') {
    return (
      <div className="whitespace-pre-wrap break-words text-accent-300">
        {line.text}
      </div>
    );
  }
  if (line.stream === 'info') {
    return <div className="whitespace-pre-wrap break-words text-surface-400">{line.text}</div>;
  }
  const color = line.stream === 'stderr' ? 'text-error-400/90' : 'text-gray-300';
  return <div className={`whitespace-pre-wrap break-words ${color}`}>{line.text || <span>&nbsp;</span>}</div>;
}

function IconBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="rounded p-1 text-surface-300 transition-colors hover:bg-surface-750 hover:text-gray-100"
    >
      {children}
    </button>
  );
}

function UnavailableNotice() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-2xs text-surface-400">
      <ShieldAlert size={20} className="text-warning-500" />
      <p>The terminal requires the local backend. Set <code className="font-mono text-surface-300">VITE_API_BASE_URL</code> to enable real command execution.</p>
    </div>
  );
}

function EmptyNotice() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5 px-4 text-center text-2xs text-surface-400">
      <TerminalIcon size={18} className="text-surface-500" />
      <p>Run a command to start a terminal session. Output streams live from the backend.</p>
    </div>
  );
}

function labelForSession(command: string, kind: string): string {
  if (kind !== 'command') return kind;
  const first = command.split('\n')[0].trim();
  return first.length > 40 ? first.slice(0, 37) + '…' : first;
}

function ApprovalDialog({ terminal }: { terminal: UseTerminalResult }) {
  const pending = terminal.pendingApproval;
  if (!pending) return null;
  const req = pending.request;
  return (
    <Dialog
      open
      onClose={() => terminal.approvePending(false)}
      title="Approve command"
      description={req.source === 'ai_proposed' ? 'AI-proposed command' : 'Sensitive command'}
      width="max-w-lg"
      footer={
        <>
          <Button variant="ghost" size="md" onClick={() => terminal.approvePending(false)}>
            Cancel
          </Button>
          <Button variant="primary" size="md" onClick={() => terminal.approvePending(true)}>
            Run command
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex items-start gap-2 rounded-lg border border-warning-500/30 bg-warning-500/5 px-3 py-2 text-2xs text-warning-300">
          <ShieldAlert size={14} className="mt-0.5 shrink-0" />
          <p>
            {req.reason || 'This command may install dependencies, execute package lifecycle scripts, or make changes that warrant confirmation. Review it before approving.'}
          </p>
        </div>
        <div className="rounded-lg border border-surface-700 bg-surface-800/60 px-3 py-2">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-surface-400">Command</div>
          <pre className="whitespace-pre-wrap break-words font-mono text-xs text-gray-100">{req.command}</pre>
        </div>
        <div className="grid grid-cols-2 gap-2 text-2xs text-surface-300">
          <div><span className="text-surface-400">Kind:</span> {req.kind}</div>
          <div><span className="text-surface-400">Source:</span> {req.source}</div>
          <div><span className="text-surface-400">Working dir:</span> {req.workingSubdir || 'project root'}</div>
          <div><span className="text-surface-400">Long-running:</span> {req.longRunning ? 'yes' : 'no'}</div>
        </div>
      </div>
    </Dialog>
  );
}


