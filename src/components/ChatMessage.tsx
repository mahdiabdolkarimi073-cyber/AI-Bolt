import { Bot, User, Check, Loader2, Circle } from 'lucide-react';
import type { ChatMessage as ChatMessageType } from '@/types';

interface Props {
  message: ChatMessageType;
}

export function ChatMessage({ message }: Props) {
  const isUser = message.role === 'user';

  return (
    <div className="flex gap-3 px-3 py-3 animate-fade-in">
      <div
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${
          isUser
            ? 'bg-surface-700 text-gray-200'
            : 'bg-gradient-to-br from-accent-500 to-accent-700 text-white'
        }`}
      >
        {isUser ? <User size={14} /> : <Bot size={14} />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-2xs font-semibold text-gray-200">
            {isUser ? 'You' : 'Assistant'}
          </span>
        </div>
        <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-surface-300">
          {message.content}
        </p>
        {message.steps && message.steps.length > 0 && (
          <div className="mt-2.5 space-y-1.5 rounded-lg border border-surface-700 bg-surface-900 p-2.5">
            {message.steps.map((step) => (
              <div key={step.id} className="flex items-center gap-2 text-2xs">
                {step.status === 'done' ? (
                  <Check size={12} className="shrink-0 text-success-500" />
                ) : step.status === 'running' ? (
                  <Loader2 size={12} className="shrink-0 animate-spin text-accent-400" />
                ) : (
                  <Circle size={8} className="shrink-0 text-surface-400" />
                )}
                <span className={step.status === 'done' ? 'text-surface-300 line-through decoration-surface-600' : 'text-gray-200'}>
                  {step.label}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
