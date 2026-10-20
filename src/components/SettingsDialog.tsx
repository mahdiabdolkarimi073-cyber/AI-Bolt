import { useState } from 'react';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import { ConnectionsPanel } from './ConnectionsPanel';
import { MemoryPanel } from './MemoryPanel';

interface Props {
  open: boolean;
  onClose: () => void;
  onSave: () => void;
}

const sections = ['AI Connections', 'Memory', 'General', 'Editor', 'Appearance', 'Shortcuts'] as const;

export function SettingsDialog({ open, onClose, onSave }: Props) {
  const [section, setSection] = useState<(typeof sections)[number]>('AI Connections');

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
