import { useState } from 'react';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import { ConnectionsPanel } from './ConnectionsPanel';
import { MemoryPanel } from './MemoryPanel';
import type { Provider, ProviderId } from '@/types';

interface Props {
  open: boolean;
  onClose: () => void;
  providers: Provider[];
  activeProvider: ProviderId;
  onProviderChange: (id: ProviderId) => void;
  onSave: () => void;
}

const sections = ['General', 'AI Providers', 'AI Connections', 'Memory', 'Editor', 'Appearance', 'Shortcuts'] as const;

export function SettingsDialog({ open, onClose, providers, activeProvider, onProviderChange, onSave }: Props) {
  const [section, setSection] = useState<(typeof sections)[number]>('AI Connections');
  const [apiKey, setApiKey] = useState('');

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Settings"
      description="Configure your AI IDE, connections, and API keys."
      width="max-w-3xl"
      footer={
        <>
          <Button variant="ghost" size="md" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={() => {
              onSave();
              onClose();
            }}
          >
            Done
          </Button>
        </>
      }
    >
      <div className="flex gap-6">
        <nav className="w-44 shrink-0">
          {sections.map((s) => (
            <button
              key={s}
              onClick={() => setSection(s)}
              className={`block w-full rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
                section === s ? 'bg-surface-750 text-gray-100' : 'text-surface-300 hover:bg-surface-800 hover:text-gray-200'
              }`}
            >
              {s}
            </button>
          ))}
        </nav>

        <div className="min-w-0 flex-1">
          {section === 'AI Connections' && <ConnectionsPanel />}

          {section === 'Memory' && <MemoryPanel />}

          {section === 'AI Providers' && (
            <div className="space-y-3">
              <div className="rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-2xs text-surface-300">
                This section shows the built-in provider list. To add real API keys and custom
                connections, use the <span className="text-accent-300">AI Connections</span> tab.
              </div>
              {providers.map((p) => {
                const active = p.id === activeProvider;
                return (
                  <div
                    key={p.id}
                    className={`rounded-lg border p-3 transition-colors ${
                      active ? 'border-accent-500/40 bg-accent-500/5' : 'border-surface-700 bg-surface-800'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-gray-100">{p.name}</span>
                        <span
                          className={`rounded-full px-1.5 py-0.5 text-[10px] ${
                            p.status === 'connected'
                              ? 'bg-success-500/15 text-success-400'
                              : 'bg-surface-700 text-surface-300'
                          }`}
                        >
                          {p.status === 'connected' ? 'Connected' : 'Not connected'}
                        </span>
                      </div>
                      <button
                        onClick={() => onProviderChange(p.id)}
                        className={`rounded-md border px-2 py-1 text-2xs transition-colors ${
                          active
                            ? 'border-accent-500/50 text-accent-400'
                            : 'border-surface-600 text-surface-300 hover:bg-surface-750'
                        }`}
                      >
                        {active ? 'Active' : 'Activate'}
                      </button>
                    </div>
                    <div className="mt-2 font-mono text-2xs text-surface-300">{p.model}</div>
                    <input
                      type="password"
                      value={active ? apiKey : ''}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder={`${p.name} API key (legacy — use AI Connections)`}
                      className="mt-2 w-full rounded-md border border-surface-600 bg-surface-850 px-2.5 py-1.5 font-mono text-2xs text-gray-100 placeholder:text-surface-400 focus:border-accent-500/50 focus:outline-none"
                    />
                  </div>
                );
              })}
            </div>
          )}

          {section === 'General' && (
            <div className="space-y-3 text-xs text-surface-300">
              <Field label="Default project location" value="~/Projects" />
              <Field label="Telemetry" value="Disabled" />
              <Field label="Auto-save" value="Enabled" />
            </div>
          )}

          {section === 'Editor' && (
            <div className="space-y-3 text-xs text-surface-300">
              <Field label="Font size" value="13px" />
              <Field label="Tab size" value="2" />
              <Field label="Word wrap" value="Off" />
            </div>
          )}

          {section === 'Appearance' && (
            <div className="space-y-3 text-xs text-surface-300">
              <Field label="Theme" value="Dark (default)" />
              <Field label="Accent color" value="Blue" />
            </div>
          )}

          {section === 'Shortcuts' && (
            <div className="space-y-2 text-xs text-surface-300">
              {[
                ['Toggle sidebar', 'Ctrl+B'],
                ['Toggle terminal', 'Ctrl+`'],
                ['Command palette', 'Ctrl+Shift+P'],
                ['Send chat message', 'Enter'],
              ].map(([k, v]) => (
                <div key={k} className="flex items-center justify-between rounded-md bg-surface-800 px-3 py-2">
                  <span>{k}</span>
                  <kbd className="rounded border border-surface-600 bg-surface-850 px-1.5 py-0.5 font-mono text-2xs text-gray-200">{v}</kbd>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-md bg-surface-800 px-3 py-2">
      <span>{label}</span>
      <span className="font-mono text-2xs text-gray-200">{value}</span>
    </div>
  );
}
