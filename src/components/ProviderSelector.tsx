import { useState, useRef, useEffect } from 'react';
import { ChevronDown, Check, Cloud, CloudOff, AlertTriangle, Loader2 } from 'lucide-react';
import type { ApiConnectionDetail } from '@/types/connections';
import { logger } from '@/lib/logger';

/** A single selectable option in the provider dropdown: one enabled model
 *  under one usable connection. Built from database connections. */
export interface ProviderOption {
  connectionId: string;
  connectionName: string;
  modelId: string;
  status: string;
}

interface Props {
  options: ProviderOption[];
  activeConnectionId: string | null;
  activeModelId: string | null;
  onChange: (connectionId: string, modelId: string) => void;
  loading: boolean;
  hasUsableConnections: boolean;
  onConfigure: () => void;
}

export function ProviderSelector({
  options,
  activeConnectionId,
  activeModelId,
  onChange,
  loading,
  hasUsableConnections,
  onConfigure,
}: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const active = options.find(
    (o) => o.connectionId === activeConnectionId && o.modelId === activeModelId,
  );

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const statusIcon = !activeConnectionId ? (
    <CloudOff size={13} className="text-surface-400" />
  ) : active?.status === 'connected' ? (
    <Cloud size={13} className="text-success-500" />
  ) : active?.status === 'error' ? (
    <AlertTriangle size={13} className="text-warning-400" />
  ) : (
    <CloudOff size={13} className="text-surface-300" />
  );

  const buttonLabel = active
    ? `${active.connectionName} · ${active.modelId}`
    : hasUsableConnections
      ? 'Select a model'
      : 'No AI configured';

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex h-7 items-center gap-2 rounded-md border border-surface-600 bg-surface-800 px-2.5 text-2xs font-medium text-gray-200 transition-colors hover:border-surface-500 hover:bg-surface-750 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={loading && options.length === 0}
      >
        {loading && options.length === 0 ? (
          <Loader2 size={13} className="animate-spin text-surface-300" />
        ) : (
          statusIcon
        )}
        <span className="max-w-[180px] truncate">{buttonLabel}</span>
        <ChevronDown size={13} className="text-surface-300" />
      </button>

      {open && (
        <div
          className="absolute right-0 top-full z-50 mt-1.5 w-72 overflow-hidden rounded-lg border border-surface-600 bg-surface-850 py-1 shadow-modal animate-fade-in"
          role="listbox"
        >
          <div className="px-3 py-1.5 text-2xs font-semibold uppercase tracking-wider text-surface-300">
            AI Provider
          </div>

          {options.length === 0 && !loading && (
            <div className="px-3 py-3 text-2xs text-surface-300">
              No usable connections. Enable a connection with an API key and at least one model.
            </div>
          )}

          {options.map((opt) => {
            const selected =
              opt.connectionId === activeConnectionId && opt.modelId === activeModelId;
            return (
              <button
                key={`${opt.connectionId}:${opt.modelId}`}
                onClick={() => {
                  logger.info('MODEL', 'Model selection changed', {
                    connectionId: opt.connectionId,
                    selectedModel: opt.modelId,
                  });
                  onChange(opt.connectionId, opt.modelId);
                  setOpen(false);
                }}
                role="option"
                aria-selected={selected}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-surface-750"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-gray-100">{opt.connectionName}</span>
                    {opt.status === 'connected' ? (
                      <span className="h-1.5 w-1.5 rounded-full bg-success-500" />
                    ) : opt.status === 'error' ? (
                      <span className="h-1.5 w-1.5 rounded-full bg-warning-400" />
                    ) : (
                      <span className="h-1.5 w-1.5 rounded-full bg-surface-400" />
                    )}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-2xs text-surface-300">{opt.modelId}</div>
                </div>
                {selected && <Check size={14} className="shrink-0 text-accent-400" />}
              </button>
            );
          })}

          <div className="mt-1 border-t border-surface-700 px-3 py-1.5">
            <button
              onClick={() => {
                setOpen(false);
                onConfigure();
              }}
              className="text-2xs text-accent-400 hover:text-accent-300"
            >
              Configure providers in Settings
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Build the list of selectable provider options from database connections.
 *  Only includes enabled connections that have at least one enabled credential
 *  and at least one enabled model. Disabled connections, disabled models, and
 *  connections without keys are excluded. */
export function buildProviderOptions(
  connections: ApiConnectionDetail[],
): ProviderOption[] {
  const options: ProviderOption[] = [];
  for (const conn of connections) {
    if (!conn.enabled) continue;
    if (!conn.hasKey) continue;
    const enabledModels = conn.models.filter((m) => m.enabled);
    for (const model of enabledModels) {
      options.push({
        connectionId: conn.id,
        connectionName: conn.displayName,
        modelId: model.modelId,
        status: conn.status,
      });
    }
  }
  return options;
}
