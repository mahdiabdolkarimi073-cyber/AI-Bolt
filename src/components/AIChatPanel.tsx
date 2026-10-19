import { useEffect, useRef, useState } from 'react';
import { PanelRightClose, Sparkles, MoreHorizontal, Trash2 } from 'lucide-react';
import { ChatMessage } from './ChatMessage';
import { ChatComposer } from './ChatComposer';
import type { ChatMessage as ChatMessageType, Provider } from '@/types';

interface Props {
  messages: ChatMessageType[];
  onSend: (text: string) => void;
  busy: boolean;
  onStop: () => void;
  onCollapse: () => void;
  activeProvider: Provider;
}

export function AIChatPanel({ messages, onSend, busy, onStop, onCollapse, activeProvider }: Props) {
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
              <span className={`h-1.5 w-1.5 rounded-full ${activeProvider.status === 'connected' ? 'bg-success-500' : 'bg-surface-400'}`} />
              {activeProvider.name} · {activeProvider.model}
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
            <ChatMessage key={m.id} message={m} />
          ))}
        </div>
      </div>

      {/* composer */}
      <ChatComposer onSend={onSend} busy={busy} onStop={onStop} />
    </div>
  );
}
