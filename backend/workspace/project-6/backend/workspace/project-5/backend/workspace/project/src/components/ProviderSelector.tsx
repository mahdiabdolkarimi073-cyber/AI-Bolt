import { useState, useRef, useEffect } from 'react';
import { ChevronDown, Check, Cloud, CloudOff } from 'lucide-react';
import type { Provider, ProviderId } from '@/types';

interface Props {
  providers: Provider[];
  activeId: ProviderId;
  onChange: (id: ProviderId) => void;
}

export function ProviderSelector({ providers, activeId, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = providers.find((p) => p.id === activeId) ?? providers[0];

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex h-7 items-center gap-2 rounded-md border border-surface-600 bg-surface-800 px-2.5 text-2xs font-medium text-gray-200 transition-colors hover:border-surface-500 hover:bg-surface-750 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {active.status === 'connected' ? (
          <Cloud size={13} className="text-success-500" />
        ) : (
          <CloudOff size={13} className="text-surface-300" />
        )}
        <span className="max-w-[120px] truncate">{active.name}</span>
        <span className="text-surface-300">·</span>
        <span className="max-w-[110px] truncate text-surface-300">{active.model}</span>
        <ChevronDown size={13} className="text-surface-300" />
      </button>

      {open && (
        <div
          className="absolute right-0 top-full z-50 mt-1.5 w-64 overflow-hidden rounded-lg border border-surface-600 bg-surface-850 py-1 shadow-modal animate-fade-in"
          role="listbox"
        >
          <div className="px-3 py-1.5 text-2xs font-semibold uppercase tracking-wider text-surface-300">
            AI Provider
          </div>
          {providers.map((p) => {
            const selected = p.id === activeId;
            return (
              <button
                key={p.id}
                onClick={() => {
                  onChange(p.id);
                  setOpen(false);
                }}
                role="option"
                aria-selected={selected}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-surface-750"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-gray-100">{p.name}</span>
                    {p.status === 'connected' ? (
                      <span className="h-1.5 w-1.5 rounded-full bg-success-500" />
                    ) : (
                      <span className="h-1.5 w-1.5 rounded-full bg-surface-400" />
                    )}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-2xs text-surface-300">{p.model}</div>
                </div>
                {selected && <Check size={14} className="shrink-0 text-accent-400" />}
              </button>
            );
          })}
          <div className="mt-1 border-t border-surface-700 px-3 py-1.5 text-2xs text-surface-300">
            Configure providers in Settings
          </div>
        </div>
      )}
    </div>
  );
}
