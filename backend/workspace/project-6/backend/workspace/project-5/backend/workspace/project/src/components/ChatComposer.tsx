import { useState, useRef, type KeyboardEvent } from 'react';
import { ArrowUp, Paperclip, Square, AtSign } from 'lucide-react';

interface Props {
  onSend: (text: string) => void;
  busy: boolean;
  onStop: () => void;
}

export function ChatComposer({ onSend, busy, onStop }: Props) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    const text = value.trim();
    if (!text || busy) return;
    onSend(text);
    setValue('');
    if (ref.current) ref.current.style.height = 'auto';
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const autoGrow = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  };

  return (
    <div className="border-t border-surface-700 bg-surface-850 p-2.5">
      <div className="rounded-xl border border-surface-600 bg-surface-800 p-2 transition-colors focus-within:border-accent-500/50">
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            autoGrow();
          }}
          onKeyDown={onKey}
          rows={1}
          placeholder="Describe what you want to build..."
          className="block max-h-40 w-full resize-none bg-transparent text-xs text-gray-100 placeholder:text-surface-400 focus:outline-none scrollbar-thin"
        />
        <div className="mt-1.5 flex items-center justify-between">
          <div className="flex items-center gap-0.5">
            <button
              className="rounded-md p-1.5 text-surface-300 transition-colors hover:bg-surface-700 hover:text-gray-100"
              aria-label="Attach file"
              title="Attach file"
            >
              <Paperclip size={14} />
            </button>
            <button
              className="rounded-md p-1.5 text-surface-300 transition-colors hover:bg-surface-700 hover:text-gray-100"
              aria-label="Mention file"
              title="Mention a file"
            >
              <AtSign size={14} />
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            {busy && (
              <button
                onClick={onStop}
                className="flex h-7 items-center gap-1.5 rounded-md border border-surface-600 bg-surface-700 px-2.5 text-2xs font-medium text-gray-100 transition-colors hover:bg-surface-650"
              >
                <Square size={11} className="fill-current" /> Stop
              </button>
            )}
            <button
              onClick={submit}
              disabled={!value.trim() && !busy}
              className="flex h-7 w-7 items-center justify-center rounded-md bg-accent-600 text-white transition-colors hover:bg-accent-500 disabled:bg-surface-700 disabled:text-surface-400"
              aria-label="Send message"
            >
              <ArrowUp size={14} />
            </button>
          </div>
        </div>
      </div>
      <p className="mt-1.5 px-1 text-2xs text-surface-400">
        Press Enter to send · Shift+Enter for a new line
      </p>
    </div>
  );
}
