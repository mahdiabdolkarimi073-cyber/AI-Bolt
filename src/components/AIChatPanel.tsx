import { useEffect, useRef, useState } from 'react';
import { PanelRightClose, Sparkles, MoreHorizontal, Trash2, AlertCircle, X, Activity } from 'lucide-react';
import { ChatMessage } from './ChatMessage';
import { ChatComposer } from './ChatComposer';
import type { ChatMessage as ChatMessageType } from '@/types';
import type { ProviderExecutionMeta } from '@/types/agent';

interface Props {
  messages: ChatMessageType[];
  onSend: (text: string) => void;
  busy: boolean;
  onStop: () => void;
  onCollapse: () => void;
  /** Display label for the active connection, shown in the chat header. */
  connectionLabel: string;
  /** Active model id, shown in the chat header. */
  modelLabel: string;
  /** Whether the active connection has been tested successfully. */
  connected: boolean;
  /** Map of message id -> simulated flag (assistant messages from the dev provider). */
  simulatedIds?: Set<string>;
  /** Last error message to surface, if any. */
  error?: string | null;
  onDismissError?: () => void;
  /** Metadata from the most recent provider request, for diagnostics. */
  lastMeta?: ProviderExecutionMeta;
}

function DiagnosticBar({ meta }: { meta: ProviderExecutionMeta }) {
  const [expanded, setExpanded] = useState(false);
  const substituted = meta.modelSubstituted === true;
  const confirmed = meta.providerActualModelConfirmed === true;
  const reportedModel = meta.providerReportedModel ?? null;
  const usage = meta.usage as Record<string, number> | undefined;
  const usageStr = usage
    ? `tokens: ${usage.promptTokenCount ?? usage.prompt_tokens ?? '?'}→${usage.candidatesTokenCount ?? usage.completion_tokens ?? '?'} (${usage.totalTokenCount ?? usage.total_tokens ?? '?'})`
    : null;

  return (
    <div className="border-b border-surface-700 bg-surface-900/60 px-3 py-1.5">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-1.5 text-2xs text-surface-300 transition-colors hover:text-gray-200"
      >
        <Activity size={11} className={substituted ? 'text-warning-400' : 'text-accent-400'} />
        <span className="font-mono">
          {meta.model ?? '?'}
          {substituted && <span className="text-warning-400"> (substituted)</span>}
        </span>
        <span className="ml-auto truncate text-surface-400">
          {reportedModel
            ? `provider: ${reportedModel}`
            : confirmed === false
              ? 'actual model unconfirmed'
              : ''}
        </span>
      </button>
      {expanded && (
        <div className="mt-1.5 space-y-1 font-mono text-2xs text-surface-300">
          <div className="flex justify-between gap-2">
            <span className="text-surface-400">requestId</span>
            <span className="truncate text-gray-300">{meta.requestId ?? '—'}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-surface-400">selectedModel</span>
            <span className="truncate text-gray-300">{meta.selectedModel ?? '—'}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-surface-400">modelSent</span>
            <span className="truncate text-gray-300">{meta.model ?? '—'}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-surface-400">providerModel</span>
            <span className="truncate text-gray-300">
              {reportedModel ?? (confirmed === false ? '(unconfirmed)' : '—')}
            </span>
          </div>
          {meta.providerResponseId && (
            <div className="flex justify-between gap-2">
              <span className="text-surface-400">responseId</span>
              <span className="truncate text-gray-300">{meta.providerResponseId}</span>
            </div>
          )}
          {usageStr && (
            <div className="flex justify-between gap-2">
              <span className="text-surface-400">usage</span>
              <span className="text-gray-300">{usageStr}</span>
            </div>
          )}
          <div className="flex justify-between gap-2">
            <span className="text-surface-400">status</span>
            <span className={meta.simulated ? 'text-warning-400' : 'text-success-500'}>
              {meta.simulated ? 'simulated' : 'real'}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export function AIChatPanel({ messages, onSend, busy, onStop, onCollapse, connectionLabel, modelLabel, connected, simulatedIds, error, onDismissError, lastMeta }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  return (
    <div className="flex h-full min-w-0 flex-col border-l border-surface-700 bg-surface-850">
      {/* header */}
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-surface-700 px-3">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-accent-500 to-accent-700">
            <Sparkles size={13} className="text-white" />
          </div>
          <div className="leading-tight">
            <div className="text-xs font-semibold text-gray-100">AI Assistant</div>
            <div className="flex items-center gap-1 text-2xs text-surface-300">
              <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-success-500' : 'bg-surface-400'}`} />
              {connectionLabel} · {modelLabel}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-0.5">
          <div className="relative">
            <button
              onClick={() => setMenuOpen((o) => !o)}
              className="rounded-md p-1.5 text-surface-300 transition-colors hover:bg-surface-750 hover:text-gray-100"
              aria-label="Chat options"
            >
              <MoreHorizontal size={15} />
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-full z-50 mt-1 w-40 overflow-hidden rounded-lg border border-surface-600 bg-surface-850 py-1 shadow-modal animate-fade-in">
                <button
                  onClick={() => setMenuOpen(false)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-2xs text-gray-200 hover:bg-surface-750"
                >
                  <Trash2 size={13} /> Clear chat
                </button>
              </div>
            )}
          </div>
          <button
            onClick={onCollapse}
            className="rounded-md p-1.5 text-surface-300 transition-colors hover:bg-surface-750 hover:text-gray-100"
            aria-label="Collapse chat panel"
          >
            <PanelRightClose size={16} />
          </button>
        </div>
      </div>

      {lastMeta && !lastMeta.simulated && <DiagnosticBar meta={lastMeta} />}

      {/* messages */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        <div className="divide-y divide-surface-800">
          {messages.map((m) => (
            <ChatMessage key={m.id} message={m} simulated={simulatedIds?.has(m.id)} />
          ))}
        </div>
      </div>

      {error && (
        <div className="mx-2.5 mb-2 flex items-start gap-2 rounded-lg border border-error-500/40 bg-error-500/10 p-2.5 text-2xs text-error-300 animate-fade-in">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span className="flex-1 leading-relaxed">{error}</span>
          {onDismissError && (
            <button onClick={onDismissError} className="shrink-0 rounded p-0.5 text-error-300 hover:bg-error-500/20" aria-label="Dismiss error">
              <X size={12} />
            </button>
          )}
        </div>
      )}

      {/* composer */}
      <ChatComposer onSend={onSend} busy={busy} onStop={onStop} />
    </div>
  );
}
