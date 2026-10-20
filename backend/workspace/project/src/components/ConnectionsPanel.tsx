import { useState } from 'react';
import {
  Plus,
  Trash2,
  KeyRound,
  Check,
  Loader2,
  AlertCircle,
  Plug,
  Cpu,
  ShieldAlert,
  CircleDot,
} from 'lucide-react';
import { Button } from './ui/Button';
import { useConnections } from '@/hooks/useConnections';
import {
  ADAPTER_LABELS,
  ADAPTER_DEFAULT_URLS,
  TEST_CATEGORY_LABELS,
  type ApiConnectionDetail,
  type AdapterId,
  type ConnectionTestResult,
} from '@/types/connections';

/**
 * AI Connections management panel, rendered inside the existing Settings dialog.
 *
 * Lets the user create, edit, and delete connections; add/remove/rotate API
 * keys; add and manage models; test a connection; and select the default
 * connection + model for new conversations.
 *
 * Every button performs its action against the backend or is explicitly
 * disabled with an explanation. When no backend is configured, the panel shows
 * a clear setup notice instead of pretending to work.
 */
export function ConnectionsPanel() {
  const c = useConnections();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  if (c.backendUnavailable) {
    return <BackendUnavailableNotice />;
  }

  if (c.loading && c.connections.length === 0) {
    return (
      <div className="flex items-center gap-2 py-6 text-xs text-surface-300">
        <Loader2 size={14} className="animate-spin" /> Loading connections…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {c.error && (
        <div className="flex items-start gap-2 rounded-md border border-error-500/40 bg-error-500/10 px-3 py-2 text-2xs text-error-300">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span className="flex-1">{c.error}</span>
          <button onClick={c.clearError} className="text-error-300 hover:text-error-200">
            Dismiss
          </button>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="text-2xs text-surface-300">
          {c.connections.length === 0
            ? 'No connections configured yet.'
            : `${c.connections.length} connection${c.connections.length === 1 ? '' : 's'}`}
        </div>
        <Button variant="primary" size="sm" onClick={() => setShowCreate(true)} disabled={showCreate}>
          <Plus size={13} className="mr-1" /> Add connection
        </Button>
      </div>

      {showCreate && (
        <CreateConnectionForm
          onCancel={() => setShowCreate(false)}
          onCreate={async (input) => {
            const ok = await c.createConnection(input);
            if (ok) setShowCreate(false);
          }}
        />
      )}

      <div className="space-y-2">
        {c.connections.map((conn) => (
          <ConnectionCard
            key={conn.id}
            conn={conn}
            isDefault={c.defaults?.connectionId === conn.id}
            expanded={expandedId === conn.id}
            onToggle={() => setExpandedId(expandedId === conn.id ? null : conn.id)}
            onTest={(model, credId) => c.testConnection(conn.id, model, credId)}
            onSetDefault={(model) => c.setDefaults(conn.id, model)}
            onUpdate={(patch) => c.updateConnection(conn.id, patch)}
            onDelete={() => c.deleteConnection(conn.id)}
            onAddCredential={(input) => c.addCredential(conn.id, input)}
            onUpdateCredential={(credId, input) => c.updateCredential(conn.id, credId, input)}
            onDeleteCredential={(credId) => c.deleteCredential(conn.id, credId)}
            onAddModel={(input) => c.addModel(conn.id, input)}
            onUpdateModel={(modelId, input) => c.updateModel(conn.id, modelId, input)}
            onDeleteModel={(modelId) => c.deleteModel(conn.id, modelId)}
          />
        ))}
      </div>
    </div>
  );
}

function BackendUnavailableNotice() {
  return (
    <div className="rounded-md border border-warning-500/40 bg-warning-500/10 px-3 py-3 text-2xs text-warning-200">
      <div className="flex items-center gap-2 font-semibold">
        <ShieldAlert size={14} /> Backend required for API key management
      </div>
      <p className="mt-1.5 leading-relaxed text-warning-200/90">
        API keys are stored securely on the local backend — never in the browser. To manage AI connections,
        start the local FastAPI backend and set <code className="font-mono text-warning-100">VITE_API_BASE_URL</code> in
        your <code className="font-mono text-warning-100">.env</code> to its address (e.g.
        <code className="font-mono text-warning-100"> http://localhost:8000</code>).
        See <code className="font-mono text-warning-100">docs/provider-management.md</code> for setup steps.
      </p>
    </div>
  );
}

// --- Connection card ---

interface ConnectionCardProps {
  conn: ApiConnectionDetail;
  isDefault: boolean;
  expanded: boolean;
  onToggle: () => void;
  onTest: (model: string, credentialId?: string) => Promise<ConnectionTestResult | null>;
  onSetDefault: (model: string) => Promise<boolean>;
  onUpdate: (patch: { displayName?: string; providerLabel?: string | null; baseUrl?: string | null; enabled?: boolean }) => Promise<ApiConnectionDetail | null>;
  onDelete: () => Promise<boolean>;
  onAddCredential: (input: { secret: string; label?: string; isPrimary?: boolean }) => Promise<boolean>;
  onUpdateCredential: (credId: string, input: { label?: string | null; enabled?: boolean; isPrimary?: boolean }) => Promise<boolean>;
  onDeleteCredential: (credId: string) => Promise<boolean>;
  onAddModel: (input: { modelId: string; label?: string; isDefault?: boolean }) => Promise<boolean>;
  onUpdateModel: (modelId: string, input: { label?: string | null; enabled?: boolean; isDefault?: boolean }) => Promise<boolean>;
  onDeleteModel: (modelId: string) => Promise<boolean>;
}

function ConnectionCard(props: ConnectionCardProps) {
  const {
    conn,
    isDefault,
    expanded,
    onToggle,
    onAddCredential,
    onUpdateCredential,
    onDeleteCredential,
    onAddModel,
    onUpdateModel,
    onDeleteModel,
    onSetDefault,
  } = props;
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(conn.displayName);
  const [editUrl, setEditUrl] = useState(conn.baseUrl ?? '');
  const [editLabel, setEditLabel] = useState(conn.providerLabel ?? '');
  const [testModel, setTestModel] = useState(conn.defaultModel ?? conn.models[0]?.modelId ?? '');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);

  const statusColor =
    conn.status === 'connected'
      ? 'text-success-400 bg-success-500/15'
      : conn.status === 'error'
        ? 'text-error-300 bg-error-500/15'
        : 'text-surface-300 bg-surface-700';

  async function handleTest() {
    if (!testModel) return;
    setTesting(true);
    setTestResult(null);
    const r = await props.onTest(testModel);
    setTestResult(r);
    setTesting(false);
  }

  return (
    <div className={`rounded-lg border transition-colors ${expanded ? 'border-accent-500/40' : 'border-surface-700 bg-surface-800'}`}>
      <div className="flex items-center justify-between gap-2 p-3">
        <button onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <Plug size={14} className={conn.enabled ? 'text-accent-400' : 'text-surface-400'} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-xs font-semibold text-gray-100">{conn.displayName}</span>
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${statusColor}`}>
                {conn.status === 'connected' ? 'Connected' : conn.status === 'error' ? 'Error' : 'Untested'}
              </span>
              {isDefault && (
                <span className="rounded-full bg-accent-500/15 px-1.5 py-0.5 text-[10px] text-accent-300">Default</span>
              )}
            </div>
            <div className="mt-0.5 truncate text-2xs text-surface-300">
              {ADAPTER_LABELS[conn.adapter]} · {conn.baseUrl || 'no base URL'} · {conn.models.length} model(s) · {conn.credentials.length} key(s)
            </div>
          </div>
        </button>
        <div className="flex items-center gap-1">
          <label className="flex cursor-pointer items-center gap-1 text-2xs text-surface-300" title="Enable/disable connection">
            <input
              type="checkbox"
              checked={conn.enabled}
              onChange={(e) => props.onUpdate({ enabled: e.target.checked })}
              className="h-3 w-3 accent-accent-500"
            />
            On
          </label>
        </div>
      </div>

      {expanded && (
        <div className="space-y-4 border-t border-surface-700 px-3 py-3">
          {/* Edit section */}
          {!editing ? (
            <button onClick={() => setEditing(true)} className="text-2xs text-accent-400 hover:text-accent-300">
              Edit details
            </button>
          ) : (
            <div className="space-y-2 rounded-md bg-surface-850 p-2">
              <FieldInput label="Display name" value={editName} onChange={setEditName} />
              <FieldInput label="Provider label (optional)" value={editLabel} onChange={setEditLabel} />
              <FieldInput label="Base URL" value={editUrl} onChange={setEditUrl} placeholder={ADAPTER_DEFAULT_URLS[conn.adapter]} />
              <div className="flex gap-2 pt-1">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={async () => {
                    await props.onUpdate({
                      displayName: editName.trim() || conn.displayName,
                      providerLabel: editLabel.trim() || null,
                      baseUrl: editUrl.trim() || null,
                    });
                    setEditing(false);
                  }}
                >
                  Save
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
              </div>
            </div>
          )}

          {/* Connection test */}
          <div className="rounded-md bg-surface-850 p-2">
            <div className="text-2xs font-semibold text-gray-200">Test connection</div>
            <div className="mt-1.5 flex items-center gap-2">
              <select
                value={testModel}
                onChange={(e) => setTestModel(e.target.value)}
                className="min-w-0 flex-1 rounded-md border border-surface-600 bg-surface-800 px-2 py-1 font-mono text-2xs text-gray-100 focus:border-accent-500/50 focus:outline-none"
                disabled={conn.models.length === 0}
              >
                {conn.models.length === 0 && <option value="">No models configured</option>}
                {conn.models.map((m) => (
                  <option key={m.id} value={m.modelId}>{m.modelId}</option>
                ))}
              </select>
              <Button variant="secondary" size="sm" onClick={handleTest} disabled={testing || !testModel}>
                {testing ? <Loader2 size={13} className="animate-spin" /> : <Plug size={13} className="mr-1" />}
                Test
              </Button>
            </div>
            <p className="mt-1 text-[10px] text-surface-400">
              Sends a minimal request (max 1 token) to the provider. May cost a tiny fraction of a cent.
            </p>
            {testResult && (
              <div
                className={`mt-2 rounded px-2 py-1.5 text-2xs ${
                  testResult.category === 'ok'
                    ? 'bg-success-500/15 text-success-300'
                    : 'bg-error-500/15 text-error-300'
                }`}
              >
                <span className="font-semibold">{TEST_CATEGORY_LABELS[testResult.category] ?? testResult.category}:</span>{' '}
                {testResult.message}
              </div>
            )}
          </div>

          {/* Credentials */}
          <CredentialsSection
            conn={conn}
            onAddCredential={onAddCredential}
            onUpdateCredential={onUpdateCredential}
            onDeleteCredential={onDeleteCredential}
          />

          {/* Models */}
          <ModelsSection
            conn={conn}
            isDefault={isDefault}
            onAddModel={onAddModel}
            onUpdateModel={onUpdateModel}
            onDeleteModel={onDeleteModel}
            onSetDefault={onSetDefault}
          />

          {/* Danger zone */}
          <div className="flex items-center justify-between border-t border-surface-700 pt-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                if (confirm(`Delete connection "${conn.displayName}"? This removes its keys and models but not conversation history.`)) {
                  void props.onDelete();
                }
              }}
            >
              <Trash2 size={13} className="mr-1 text-error-300" /> Delete connection
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Credentials section ---

interface CredentialsSectionProps {
  conn: ApiConnectionDetail;
  onAddCredential: (input: { secret: string; label?: string; isPrimary?: boolean }) => Promise<boolean>;
  onUpdateCredential: (credId: string, input: { label?: string | null; enabled?: boolean; isPrimary?: boolean }) => Promise<boolean>;
  onDeleteCredential: (credId: string) => Promise<boolean>;
}

interface ModelsSectionProps {
  conn: ApiConnectionDetail;
  isDefault: boolean;
  onAddModel: (input: { modelId: string; label?: string; isDefault?: boolean }) => Promise<boolean>;
  onUpdateModel: (modelId: string, input: { label?: string | null; enabled?: boolean; isDefault?: boolean }) => Promise<boolean>;
  onDeleteModel: (modelId: string) => Promise<boolean>;
  onSetDefault: (model: string) => Promise<boolean>;
}

function CredentialsSection({ conn, onAddCredential, onUpdateCredential, onDeleteCredential }: CredentialsSectionProps) {
  const [secret, setSecret] = useState('');
  const [label, setLabel] = useState('');
  const [adding, setAdding] = useState(false);

  return (
    <div className="rounded-md bg-surface-850 p-2">
      <div className="flex items-center gap-1.5 text-2xs font-semibold text-gray-200">
        <KeyRound size={13} /> API keys
      </div>
      <p className="mt-1 text-[10px] text-surface-400">
        Keys are encrypted on the backend and never shown again after saving. Multiple keys allow failover.
      </p>

      <div className="mt-2 space-y-1.5">
        {conn.credentials.length === 0 && (
          <div className="text-2xs text-surface-400">No keys added yet.</div>
        )}
        {conn.credentials.map((cred) => (
          <div key={cred.id} className="flex items-center gap-2 rounded bg-surface-800 px-2 py-1.5">
            <CircleDot size={11} className={cred.enabled ? 'text-success-400' : 'text-surface-500'} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-2xs text-gray-200">{cred.keyMask}</div>
              <div className="text-[10px] text-surface-400">
                {cred.label || 'no label'} {cred.isPrimary && '· primary'}
              </div>
            </div>
            <button
              onClick={() => onUpdateCredential(cred.id, { isPrimary: true })}
              className={`rounded px-1.5 py-0.5 text-[10px] ${cred.isPrimary ? 'text-accent-300' : 'text-surface-300 hover:bg-surface-750'}`}
              disabled={cred.isPrimary}
            >
              {cred.isPrimary ? 'Primary' : 'Set primary'}
            </button>
            <button
              onClick={() => onUpdateCredential(cred.id, { enabled: !cred.enabled })}
              className="rounded px-1.5 py-0.5 text-[10px] text-surface-300 hover:bg-surface-750"
            >
              {cred.enabled ? 'Disable' : 'Enable'}
            </button>
            <button
              onClick={() => {
                if (confirm('Remove this API key?')) onDeleteCredential(cred.id);
              }}
              className="rounded px-1.5 py-0.5 text-[10px] text-error-300 hover:bg-error-500/10"
            >
              <Trash2 size={11} />
            </button>
          </div>
        ))}
      </div>

      {adding ? (
        <div className="mt-2 space-y-1.5">
          <FieldInput label="New API key" value={secret} onChange={setSecret} placeholder="sk-..." mono password />
          <FieldInput label="Label (optional)" value={label} onChange={setLabel} placeholder="e.g. personal key" />
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={async () => {
                if (!secret.trim()) return;
                setAdding(true);
                const ok = await onAddCredential({ secret: secret.trim(), label: label.trim() || undefined });
                setAdding(false);
                if (ok) {
                  setSecret('');
                  setLabel('');
                }
              }}
              disabled={!secret.trim()}
            >
              Save key
            </Button>
            <Button variant="ghost" size="sm" onClick={() => { setAdding(false); setSecret(''); setLabel(''); }}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} className="mt-2 flex items-center gap-1 text-2xs text-accent-400 hover:text-accent-300">
          <Plus size={12} /> Add key
        </button>
      )}
    </div>
  );
}

// --- Models section ---

function ModelsSection({ conn, isDefault, onAddModel, onUpdateModel, onDeleteModel, onSetDefault }: ModelsSectionProps) {
  const [modelId, setModelId] = useState('');
  const [modelLabel, setModelLabel] = useState('');
  const [adding, setAdding] = useState(false);

  return (
    <div className="rounded-md bg-surface-850 p-2">
      <div className="flex items-center gap-1.5 text-2xs font-semibold text-gray-200">
        <Cpu size={13} /> Models
      </div>
      <p className="mt-1 text-[10px] text-surface-400">
        Manually enter model IDs. Capabilities are unknown unless the provider reports them.
      </p>

      <div className="mt-2 space-y-1.5">
        {conn.models.length === 0 && <div className="text-2xs text-surface-400">No models added yet.</div>}
        {conn.models.map((m) => (
          <div key={m.id} className="flex items-center gap-2 rounded bg-surface-800 px-2 py-1.5">
            <CircleDot size={11} className={m.enabled ? 'text-success-400' : 'text-surface-500'} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-2xs text-gray-200">{m.modelId}</div>
              <div className="text-[10px] text-surface-400">{m.label || 'no label'}</div>
            </div>
            <button
              onClick={() => onSetDefault(m.modelId)}
              className={`flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] ${
                isDefault && conn.defaultModel === m.modelId ? 'text-accent-300' : 'text-surface-300 hover:bg-surface-750'
              }`}
            >
              {isDefault && conn.defaultModel === m.modelId && <Check size={10} />}
              Default
            </button>
            <button
              onClick={() => onUpdateModel(m.id, { enabled: !m.enabled })}
              className="rounded px-1.5 py-0.5 text-[10px] text-surface-300 hover:bg-surface-750"
            >
              {m.enabled ? 'Disable' : 'Enable'}
            </button>
            <button
              onClick={() => { if (confirm('Remove this model?')) onDeleteModel(m.id); }}
              className="rounded px-1.5 py-0.5 text-[10px] text-error-300 hover:bg-error-500/10"
            >
              <Trash2 size={11} />
            </button>
          </div>
        ))}
      </div>

      {adding ? (
        <div className="mt-2 space-y-1.5">
          <FieldInput label="Model ID" value={modelId} onChange={setModelId} placeholder="e.g. gemini-2.0-flash" mono />
          <FieldInput label="Label (optional)" value={modelLabel} onChange={setModelLabel} />
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={async () => {
                if (!modelId.trim()) return;
                const ok = await onAddModel({ modelId: modelId.trim(), label: modelLabel.trim() || undefined });
                if (ok) { setModelId(''); setModelLabel(''); }
              }}
              disabled={!modelId.trim()}
            >
              Add model
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} className="mt-2 flex items-center gap-1 text-2xs text-accent-400 hover:text-accent-300">
          <Plus size={12} /> Add model
        </button>
      )}
    </div>
  );
}

// --- Create connection form ---

function CreateConnectionForm({ onCancel, onCreate }: { onCancel: () => void; onCreate: (input: { displayName: string; adapter: AdapterId; providerLabel?: string; baseUrl?: string }) => Promise<void> }) {
  const [displayName, setDisplayName] = useState('');
  const [adapter, setAdapter] = useState<AdapterId>('openai_compatible');
  const [providerLabel, setProviderLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState(ADAPTER_DEFAULT_URLS.openai_compatible);
  const [busy, setBusy] = useState(false);

  return (
    <div className="space-y-2 rounded-md border border-accent-500/30 bg-surface-850 p-2.5">
      <div className="text-2xs font-semibold text-gray-200">New connection</div>
      <FieldInput label="Display name" value={displayName} onChange={setDisplayName} placeholder="e.g. My Groq key" />
      <div className="space-y-1">
        <label className="text-[10px] text-surface-300">Adapter / protocol</label>
        <select
          value={adapter}
          onChange={(e) => {
            const next = e.target.value as AdapterId;
            setAdapter(next);
            setBaseUrl(ADAPTER_DEFAULT_URLS[next]);
          }}
          className="w-full rounded-md border border-surface-600 bg-surface-800 px-2 py-1 text-2xs text-gray-100 focus:border-accent-500/50 focus:outline-none"
        >
          {(Object.keys(ADAPTER_LABELS) as AdapterId[]).map((a) => (
            <option key={a} value={a}>{ADAPTER_LABELS[a]}</option>
          ))}
        </select>
      </div>
      <FieldInput label="Provider label (optional)" value={providerLabel} onChange={setProviderLabel} placeholder="e.g. GroqCloud" />
      <FieldInput label="Base URL" value={baseUrl} onChange={setBaseUrl} mono placeholder={ADAPTER_DEFAULT_URLS[adapter]} />
      <div className="flex gap-2 pt-1">
        <Button
          variant="primary"
          size="sm"
          disabled={busy || !displayName.trim()}
          onClick={async () => {
            setBusy(true);
            await onCreate({
              displayName: displayName.trim(),
              adapter,
              providerLabel: providerLabel.trim() || undefined,
              baseUrl: baseUrl.trim() || undefined,
            });
            setBusy(false);
          }}
        >
          {busy && <Loader2 size={13} className="mr-1 animate-spin" />}
          Create
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

// --- Small field helper ---

function FieldInput({
  label,
  value,
  onChange,
  placeholder,
  mono,
  password,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  password?: boolean;
}) {
  return (
    <div className="space-y-1">
      <label className="text-[10px] text-surface-300">{label}</label>
      <input
        type={password ? 'password' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full rounded-md border border-surface-600 bg-surface-800 px-2 py-1 text-2xs text-gray-100 placeholder:text-surface-400 focus:border-accent-500/50 focus:outline-none ${mono ? 'font-mono' : ''}`}
      />
    </div>
  );
}

