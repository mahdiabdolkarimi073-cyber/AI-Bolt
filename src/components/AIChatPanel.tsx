import { useEffect, useRef, useState } from 'react';
import { PanelRightClose, Sparkles, MoreHorizontal, Trash2, AlertCircle, X } from 'lucide-react';
import { ChatMessage } from './ChatMessage';
import { ChatComposer } from './ChatComposer';
import type { ChatMessage as ChatMessageType } from '@/types';

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
}

export function AIChatPanel({ messages, onSend, busy, onStop, onCollapse, connectionLabel, modelLabel, connected, simulatedIds, error, onDismissError }: Props) {
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
