import { useState, useRef, useEffect } from 'react';
import {
  Terminal as TerminalIcon,
  AlertTriangle,
  ScrollText,
  FlaskConical,
  Monitor,
  ChevronDown,
  X,
  ExternalLink,
  RefreshCw,
  ShieldAlert,
  CheckCircle2,
  XCircle,
  Loader2,
  Play,
  Square,
} from 'lucide-react';
import type { BottomTab } from '@/types';
import { sampleProblems } from '@/data/mock';
import { TerminalPanel } from './TerminalPanel';
import type { UseTerminalResult } from '@/hooks/useTerminal';
import type { UsePreviewResult } from '@/hooks/usePreview';

interface Props {
  open: boolean;
  onToggle: () => void;
  activeTab: BottomTab;
  onTabChange: (t: BottomTab) => void;
  terminal: UseTerminalResult;
  preview: UsePreviewResult;
  height: number;
}

const tabs: { id: BottomTab; label: string; icon: typeof TerminalIcon }[] = [
  { id: 'terminal', label: 'Terminal', icon: TerminalIcon },
  { id: 'preview', label: 'Preview', icon: Monitor },
  { id: 'problems', label: 'Problems', icon: AlertTriangle },
  { id: 'output', label: 'Output', icon: ScrollText },
  { id: 'tests', label: 'Tests', icon: FlaskConical },
];

export function BottomPanel({ open, onToggle, activeTab, onTabChange, terminal, preview, height }: Props) {

  // Live test sessions
  const testSessions = terminal.sessions.filter((s) => s.kind === 'test');

  // Badge counts
  const terminalBadge = terminal.sessions.length > 0 ? terminal.sessions.length : undefined;
  const testsBadge = testSessions.length > 0 ? testSessions.length : undefined;
  const problemsBadge = sampleProblems.length > 0 ? sampleProblems.length : undefined;

  function badgeFor(id: BottomTab): number | undefined {
    if (id === 'terminal') return terminalBadge;
    if (id === 'tests') return testsBadge;
    if (id === 'problems') return problemsBadge;
    return undefined;
  }

  return (
    <div className="flex shrink-0 flex-col border-t border-surface-700 bg-surface-900" style={{ height: open ? height : 32 }}>
      {/* tab bar */}
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-surface-800 pr-2">
        <div className="flex h-full items-stretch">
          {tabs.map((t) => {
            const Icon = t.icon;
            const active = activeTab === t.id;
            const badge = badgeFor(t.id);
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
                {badge !== undefined && (
                  <span className="ml-0.5 rounded-full bg-surface-700 px-1.5 text-[10px] text-surface-300">{badge}</span>
                )}
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
          {activeTab === 'preview' && <PreviewView preview={preview} />}
          {activeTab === 'problems' && (
            <div className="h-full overflow-auto scrollbar-thin">
              <ProblemsView />
            </div>
          )}
          {activeTab === 'output' && (
            <div className="h-full overflow-auto scrollbar-thin">
              <OutputView terminal={terminal} />
            </div>
          )}
          {activeTab === 'tests' && (
            <div className="h-full overflow-auto scrollbar-thin">
              <TestsView sessions={testSessions} terminal={terminal} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- Preview tab ---

function PreviewView({ preview }: { preview: UsePreviewResult }) {
  const [iframeKey, setIframeKey] = useState(0);
  const [iframeBlocked, setIframeBlocked] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const { state, url, command, error, starting, stopping, available } = preview;

  // Reset iframe blocked state when URL changes.
  useEffect(() => {
    setIframeBlocked(false);
  }, [url]);

  const isRunning = state === 'running' || state === 'starting';

  const statusBadge = (() => {
    switch (state) {
      case 'running':
        return { label: 'Running', color: 'text-success-500', icon: CheckCircle2 };
      case 'starting':
        return { label: 'Starting...', color: 'text-accent-400', icon: Loader2 };
      case 'error':
        return { label: 'Error', color: 'text-error-400', icon: XCircle };
      case 'stopped':
        return { label: 'Stopped', color: 'text-surface-400', icon: Square };
      default:
        return { label: 'Idle', color: 'text-surface-400', icon: Monitor };
    }
  })();
  const StatusIcon = statusBadge.icon;

  // --- No project / backend unavailable ---
  if (!available) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-2xs text-surface-400">
        <Monitor size={22} className="text-surface-500" />
        <p className="font-medium text-surface-300">Preview unavailable</p>
        <p>The local backend is not configured. Preview requires the backend to run dev servers.</p>
      </div>
    );
  }

  // --- Idle / stopped state with start button ---
  if (state === 'idle' || state === 'stopped') {
    return (
      <div className="flex h-full flex-col">
        {/* toolbar */}
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-surface-800 bg-surface-900 px-2">
          <div className="flex items-center gap-1.5 text-2xs text-surface-300">
            <StatusIcon size={13} className={statusBadge.color} />
            <span className={statusBadge.color}>{statusBadge.label}</span>
          </div>
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={() => void preview.start()}
              disabled={starting}
              className="inline-flex items-center gap-1.5 rounded-md border border-accent-500/40 bg-accent-500/10 px-2.5 py-1 text-2xs font-medium text-accent-300 transition-colors hover:bg-accent-500/20 disabled:opacity-50"
              title="Start dev server"
            >
              {starting ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
              Start Preview
            </button>
          </div>
        </div>
        {error && state === 'stopped' && (
          <div className="border-b border-error-500/20 bg-error-500/5 px-3 py-1.5 text-2xs text-error-400">
            {error}
          </div>
        )}
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-2xs text-surface-400">
          <Monitor size={22} className="text-surface-500" />
          <p className="font-medium text-surface-300">No preview running</p>
          <p>Click "Start Preview" to detect the project runtime and launch its dev server. The preview will appear here once the server is ready.</p>
          {preview.runtime && (
            <p className="mt-1 text-surface-500">Detected: {preview.runtime}{preview.framework ? ` / ${preview.framework}` : ''}</p>
          )}
        </div>
      </div>
    );
  }

  // --- Error state ---
  if (state === 'error') {
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-surface-800 bg-surface-900 px-2">
          <div className="flex items-center gap-1.5 text-2xs text-surface-300">
            <StatusIcon size={13} className={statusBadge.color} />
            <span className={statusBadge.color}>{statusBadge.label}</span>
          </div>
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={() => void preview.start()}
              disabled={starting}
              className="inline-flex items-center gap-1.5 rounded-md border border-accent-500/40 bg-accent-500/10 px-2.5 py-1 text-2xs font-medium text-accent-300 transition-colors hover:bg-accent-500/20 disabled:opacity-50"
              title="Restart dev server"
            >
              {starting ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
              Restart
            </button>
            <button
              onClick={() => setShowLogs((s) => !s)}
              className="rounded p-1 text-surface-400 transition-colors hover:bg-surface-750 hover:text-gray-100"
              title="Toggle logs"
            >
              <ScrollText size={13} />
            </button>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-2xs text-surface-400">
          <XCircle size={22} className="text-error-400" />
          <p className="font-medium text-error-400">Preview failed to start</p>
          {error && (
            <div className="mt-1 max-h-32 overflow-auto rounded border border-surface-800 bg-surface-850 px-3 py-2 font-mono text-[11px] text-error-400/90 scrollbar-thin">
              {error}
            </div>
          )}
          {showLogs && preview.logs.length > 0 && (
            <div className="mt-2 max-h-40 w-full max-w-2xl overflow-auto rounded border border-surface-800 bg-surface-850 px-3 py-2 font-mono text-[10px] leading-relaxed scrollbar-thin">
              {preview.logs.slice(-80).map((l, i) => (
                <div key={i} className={l.stream === 'stderr' ? 'text-error-400/80' : 'text-surface-300'}>
                  {l.text || '\u00A0'}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // --- Running / starting state ---
  return (
    <div className="flex h-full flex-col">
      {/* toolbar */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-surface-800 bg-surface-900 px-2">
        <div className="flex items-center gap-1.5 text-2xs text-surface-300">
          <StatusIcon size={13} className={`${statusBadge.color} ${state === 'starting' ? 'animate-spin' : ''}`} />
          <span className={statusBadge.color}>{statusBadge.label}</span>
        </div>
        <div className="flex-1 truncate rounded border border-surface-700 bg-surface-800 px-2 py-0.5 font-mono text-[11px] text-surface-300">
          {url ?? (state === 'starting' ? 'Waiting for server...' : command ?? '')}
        </div>
        <button
          title="Refresh preview"
          onClick={() => { setIframeKey((k) => k + 1); setIframeBlocked(false); }}
          disabled={!url}
          className="rounded p-1 text-surface-400 transition-colors hover:bg-surface-750 hover:text-gray-100 disabled:opacity-30"
        >
          <RefreshCw size={13} />
        </button>
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            title="Open in browser"
            className="rounded p-1 text-surface-400 transition-colors hover:bg-surface-750 hover:text-gray-100"
          >
            <ExternalLink size={13} />
          </a>
        )}
        <button
          onClick={() => setShowLogs((s) => !s)}
          className={`rounded p-1 transition-colors hover:bg-surface-750 hover:text-gray-100 ${showLogs ? 'text-accent-400' : 'text-surface-400'}`}
          title="Toggle logs"
        >
          <ScrollText size={13} />
        </button>
        <button
          onClick={() => void preview.stop()}
          disabled={stopping}
          className="rounded p-1 text-error-400 transition-colors hover:bg-error-500/10 disabled:opacity-50"
          title="Stop server"
        >
          {stopping ? <Loader2 size={13} className="animate-spin" /> : <Square size={13} />}
        </button>
      </div>

      {/* logs panel (toggleable) */}
      {showLogs && (
        <div className="max-h-32 shrink-0 overflow-auto border-b border-surface-800 bg-surface-950 px-2 py-1 font-mono text-[10px] leading-relaxed scrollbar-thin">
          {preview.logs.length === 0 ? (
            <div className="px-1 py-1 text-surface-500">No output yet.</div>
          ) : (
            preview.logs.slice(-100).map((l, i) => (
              <div key={i} className={l.stream === 'stderr' ? 'text-error-400/80' : 'text-surface-300'}>
                {l.text || '\u00A0'}
              </div>
            ))
          )}
        </div>
      )}

      {/* iframe / fallback */}
      <div className="relative min-h-0 flex-1 bg-white">
        {state === 'starting' && !url ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 bg-surface-900 px-6 text-center text-2xs text-surface-400">
            <Loader2 size={22} className="animate-spin text-accent-400" />
            <p className="font-medium text-surface-300">Starting dev server...</p>
            <p className="text-surface-500">{command}</p>
            <p>Waiting for the server to print its local URL.</p>
          </div>
        ) : iframeBlocked ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 bg-surface-900 px-6 text-center text-2xs text-surface-400">
            <ShieldAlert size={20} className="text-warning-500" />
            <p className="font-medium text-surface-300">Preview blocked by the server</p>
            <p>The development server sent an <code className="font-mono text-surface-300">X-Frame-Options</code> or <code className="font-mono text-surface-300">Content-Security-Policy</code> header that prevents embedding. Use the button above to open it in your browser instead.</p>
            {url && (
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex items-center gap-1.5 rounded-md border border-accent-500/40 bg-accent-500/10 px-3 py-1.5 text-xs font-medium text-accent-300 transition-colors hover:bg-accent-500/20"
              >
                <ExternalLink size={13} /> Open in browser
              </a>
            )}
          </div>
        ) : url ? (
          <iframe
            key={iframeKey}
            ref={iframeRef}
            src={url}
            title="Live preview"
            className="h-full w-full border-0"
            onError={() => setIframeBlocked(true)}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 bg-surface-900 px-6 text-center text-2xs text-surface-400">
            <Monitor size={22} className="text-surface-500" />
            <p className="font-medium text-surface-300">Waiting for server URL...</p>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Problems tab ---

function ProblemsView() {
  return (
    <div className="px-2 py-1.5">
      {sampleProblems.length === 0 ? (
        <div className="flex items-center gap-2 px-2 py-3 text-2xs text-surface-400">No problems detected.</div>
      ) : (
        sampleProblems.map((p, i) => (
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
        ))
      )}
    </div>
  );
}

// --- Output tab: shows stdout/stderr from the active or most recent session ---

function OutputView({ terminal }: { terminal: UseTerminalResult }) {
  const session = terminal.activeSession ?? terminal.sessions[terminal.sessions.length - 1] ?? null;
  if (!session) {
    return (
      <div className="px-3 py-3 text-2xs text-surface-400">No output yet. Run a command in the Terminal tab.</div>
    );
  }
  const lines = session.lines.filter((l) => l.stream === 'stdout' || l.stream === 'stderr');
  if (lines.length === 0) {
    return <div className="px-3 py-3 text-2xs text-surface-400">No output captured for this session.</div>;
  }
  return (
    <div className="px-3 py-2 font-mono text-2xs leading-relaxed">
      {lines.map((line) => (
        <div key={line.id} className={line.stream === 'stderr' ? 'text-error-400/90' : 'text-surface-300'}>
          {line.text || <span>&nbsp;</span>}
        </div>
      ))}
    </div>
  );
}

// --- Tests tab: shows real test sessions from terminal ---

function TestsView({ sessions, terminal }: { sessions: UseTerminalResult['sessions']; terminal: UseTerminalResult }) {
  if (sessions.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-2xs text-surface-400">
        <FlaskConical size={20} className="text-surface-500" />
        <p className="font-medium text-surface-300">No test runs yet</p>
        <p>Run a test command from the Terminal toolbar or type one in the terminal. Results will appear here.</p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-surface-800">
      {sessions.map((s) => {
        const running = s.status === 'running' || s.status === 'pending';
        const passed = s.status === 'completed' && s.exitCode === 0;
        const failed = s.status === 'failed' || (s.status === 'completed' && s.exitCode !== 0);
        const Icon = running ? Loader2 : passed ? CheckCircle2 : failed ? XCircle : FlaskConical;
        const color = running ? 'text-accent-400' : passed ? 'text-success-500' : failed ? 'text-error-400' : 'text-surface-400';

        return (
          <div key={s.id} className="px-3 py-2">
            <div className="flex items-center gap-2">
              <Icon size={14} className={`shrink-0 ${color} ${running ? 'animate-spin' : ''}`} />
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-gray-200">{s.command}</span>
              {s.exitCode != null && (
                <span className={`shrink-0 text-[10px] font-mono ${s.exitCode === 0 ? 'text-success-500' : 'text-error-400'}`}>
                  exit {s.exitCode}
                </span>
              )}
              <button
                onClick={() => terminal.selectSession(s.id)}
                className="shrink-0 text-[10px] text-surface-400 hover:text-accent-300"
                title="View in terminal"
              >
                view
              </button>
            </div>
            {/* Show last few lines of output */}
            {s.lines.length > 0 && (
              <div className="ml-5 mt-1 max-h-28 overflow-auto rounded border border-surface-800 bg-surface-800/40 px-2 py-1 font-mono text-[10px] leading-relaxed scrollbar-thin">
                {s.lines.slice(-30).map((l) => (
                  <div key={l.id} className={l.stream === 'stderr' ? 'text-error-400/80' : 'text-surface-300'}>
                    {l.text || <span>&nbsp;</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
