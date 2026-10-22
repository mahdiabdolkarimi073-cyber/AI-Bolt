import { useState } from 'react';
import {
  Plus,
  Trash2,
  Layers,
  Check,
  Loader2,
  AlertCircle,
  ArrowUp,
  ArrowDown,
  CircleDot,
} from 'lucide-react';
import { Button } from './ui/Button';
import { useProfiles } from '@/hooks/useProfiles';
import { useConnections } from '@/hooks/useConnections';
import type { ModelProfile, ProfileCandidate } from '@/types/profiles';
import type { ApiConnectionDetail } from '@/types/connections';

export function ProfilesPanel() {
  const p = useProfiles();
  const c = useConnections();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  if (p.backendUnavailable) {
    return (
      <div className="rounded-md border border-warning-500/40 bg-warning-500/10 px-3 py-3 text-2xs text-warning-200">
        <div className="flex items-center gap-2 font-semibold">
          <AlertCircle size={14} /> Backend required for profile management
        </div>
        <p className="mt-1.5 leading-relaxed text-warning-200/90">
          Model profiles need the local backend to store fallback chains. Start the backend and set
          <code className="font-mono text-warning-100"> VITE_API_BASE_URL</code> in your
          <code className="font-mono text-warning-100"> .env</code>.
        </p>
      </div>
    );
  }

  if (p.loading && p.profiles.length === 0) {
    return (
      <div className="flex items-center gap-2 py-6 text-xs text-surface-300">
        <Loader2 size={14} className="animate-spin" /> Loading profiles…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {p.error && (
        <div className="flex items-start gap-2 rounded-md border border-error-500/40 bg-error-500/10 px-3 py-2 text-2xs text-error-300">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span className="flex-1">{p.error}</span>
          <button onClick={p.clearError} className="text-error-300 hover:text-error-200">Dismiss</button>
        </div>
      )}

      <div className="rounded-md bg-surface-850 px-3 py-2 text-2xs text-surface-300">
        Create fallback chains so when one AI provider fails, the next candidate model is tried automatically.
      </div>

      <div className="flex items-center justify-between">
        <div className="text-2xs text-surface-300">
          {p.profiles.length === 0
            ? 'No profiles configured yet.'
            : `${p.profiles.length} profile${p.profiles.length === 1 ? '' : 's'}`}
        </div>
        <Button variant="primary" size="sm" onClick={() => setShowCreate(true)} disabled={showCreate}>
          <Plus size={13} className="mr-1" /> Add profile
        </Button>
      </div>

      {showCreate && (
        <CreateProfileForm
          onCancel={() => setShowCreate(false)}
          onSubmit={async (input) => {
            const prof = await p.createProfile(input);
            if (prof) { setShowCreate(false); setExpandedId(prof.id); }
            return prof !== null;
          }}
        />
      )}

      <div className="space-y-2">
        {p.profiles.map((prof) => (
          <ProfileCard
            key={prof.id}
            profile={prof}
            connections={c.connections}
            isDefault={p.defaultProfile?.profileId === prof.id}
            expanded={expandedId === prof.id}
            onToggle={() => setExpandedId(expandedId === prof.id ? null : prof.id)}
            onSetDefault={() => p.setDefaultProfile(prof.id)}
            onUpdate={(patch) => p.updateProfile(prof.id, patch)}
            onDelete={() => {
              if (confirm(`Delete profile "${prof.name}"?`)) p.deleteProfile(prof.id);
            }}
            onAddCandidate={(input) => p.addCandidate(prof.id, input)}
            onUpdateCandidate={(cid, input) => p.updateCandidate(prof.id, cid, input)}
            onDeleteCandidate={(cid) => p.deleteCandidate(prof.id, cid)}
            onReorder={(ids) => p.reorderCandidates(prof.id, ids)}
          />
        ))}
      </div>
    </div>
  );
}

interface ProfileCardProps {
  profile: ModelProfile;
  connections: ApiConnectionDetail[];
  isDefault: boolean;
  expanded: boolean;
  onToggle: () => void;
  onSetDefault: () => void;
  onUpdate: (patch: { name?: string; description?: string; enabled?: boolean }) => Promise<ModelProfile | null>;
  onDelete: () => void;
  onAddCandidate: (input: { connectionId: string; modelId: string; priority?: number; label?: string }) => Promise<boolean>;
  onUpdateCandidate: (cid: string, input: { priority?: number; enabled?: boolean; label?: string | null }) => Promise<boolean>;
  onDeleteCandidate: (cid: string) => Promise<boolean>;
  onReorder: (orderedIds: string[]) => Promise<boolean>;
}

function ProfileCard(props: ProfileCardProps) {
  const { profile: prof, isDefault, expanded, onToggle } = props;
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(prof.name);
  const [editDesc, setEditDesc] = useState(prof.description);

  const enabledCount = prof.candidates.filter((c) => c.enabled).length;

  async function moveCandidate(idx: number, dir: -1 | 1) {
    const ordered = [...prof.candidates].sort((a, b) => a.priority - b.priority);
    const target = idx + dir;
    if (target < 0 || target >= ordered.length) return;
    [ordered[idx], ordered[target]] = [ordered[target], ordered[idx]];
    await props.onReorder(ordered.map((c) => c.id));
  }

  return (
    <div className={`rounded-lg border transition-colors ${expanded ? 'border-accent-500/40' : 'border-surface-700 bg-surface-800'}`}>
      <div className="flex items-center justify-between gap-2 p-3">
        <button onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <Layers size={14} className={prof.enabled ? 'text-accent-400' : 'text-surface-400'} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-xs font-semibold text-gray-100">{prof.name}</span>
              {isDefault && (
                <span className="rounded-full bg-accent-500/15 px-1.5 py-0.5 text-[10px] text-accent-300">Default</span>
              )}
              {!prof.enabled && (
                <span className="rounded-full bg-surface-700 px-1.5 py-0.5 text-[10px] text-surface-400">Disabled</span>
              )}
            </div>
            <div className="mt-0.5 truncate text-2xs text-surface-300">
              {enabledCount} candidate{enabledCount === 1 ? '' : 's'}
              {prof.description ? ` · ${prof.description}` : ''}
            </div>
          </div>
        </button>
        <div className="flex items-center gap-1">
          <label className="flex cursor-pointer items-center gap-1 text-2xs text-surface-300" title="Enable/disable profile">
            <input
              type="checkbox"
              checked={prof.enabled}
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
            <div className="flex items-center gap-3">
              <button onClick={() => setEditing(true)} className="text-2xs text-accent-400 hover:text-accent-300">Edit details</button>
              {!isDefault && prof.enabled && (
                <button onClick={props.onSetDefault} className="text-2xs text-accent-400 hover:text-accent-300">Set as default</button>
              )}
            </div>
          ) : (
            <div className="space-y-2 rounded-md bg-surface-850 p-2">
              <FieldInput label="Name" value={editName} onChange={setEditName} />
              <FieldInput label="Description" value={editDesc} onChange={setEditDesc} />
              <div className="flex gap-2 pt-1">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={async () => {
                    await props.onUpdate({ name: editName.trim() || prof.name, description: editDesc.trim() });
                    setEditing(false);
                  }}
                >Save</Button>
                <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
              </div>
            </div>
          )}

          {/* Candidates list */}
          <div className="rounded-md bg-surface-850 p-2">
            <div className="flex items-center gap-1.5 text-2xs font-semibold text-gray-200">
              <Layers size={13} /> Fallback order
            </div>
            <p className="mt-1 text-[10px] text-surface-400">
              Candidates are tried top-to-bottom. The first one is the primary; the rest are fallbacks.
            </p>

            <div className="mt-2 space-y-1.5">
              {prof.candidates.length === 0 && (
                <div className="text-2xs text-surface-400">No candidates added yet.</div>
              )}
              {[...prof.candidates].sort((a, b) => a.priority - b.priority).map((cand, idx) => {
                const conn = props.connections.find((c) => c.id === cand.connectionId);
                return (
                  <CandidateRow
                    key={cand.id}
                    cand={cand}
                    idx={idx}
                    total={prof.candidates.length}
                    connName={conn?.displayName ?? '(missing connection)'}
                    onMoveUp={() => moveCandidate(idx, -1)}
                    onMoveDown={() => moveCandidate(idx, 1)}
                    onToggleEnabled={() => props.onUpdateCandidate(cand.id, { enabled: !cand.enabled })}
                    onDelete={() => { if (confirm('Remove this candidate?')) props.onDeleteCandidate(cand.id); }}
                  />
                );
              })}
            </div>

            <AddCandidateForm
              connections={props.connections}
              onAdd={props.onAddCandidate}
              nextPriority={prof.candidates.length + 1}
            />
          </div>

          {/* Danger zone */}
          <div className="flex items-center justify-between border-t border-surface-700 pt-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={props.onDelete}
            >
              <Trash2 size={13} className="mr-1 text-error-300" /> Delete profile
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function CandidateRow({
  cand, idx, total, connName,
  onMoveUp, onMoveDown, onToggleEnabled, onDelete,
}: {
  cand: ProfileCandidate;
  idx: number;
  total: number;
  connName: string;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onToggleEnabled: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded bg-surface-800 px-2 py-1.5">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-700 text-[10px] font-mono text-surface-300">
        {idx + 1}
      </span>
      <CircleDot size={11} className={cand.enabled ? 'text-success-400' : 'text-surface-500'} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-2xs text-gray-200">{cand.modelId}</div>
        <div className="truncate text-[10px] text-surface-400">
          {connName}{cand.label ? ` · ${cand.label}` : ''}
        </div>
      </div>
      <div className="flex items-center gap-0.5">
        <button onClick={onMoveUp} disabled={idx === 0} className="rounded p-1 text-surface-300 hover:bg-surface-750 disabled:opacity-30">
          <ArrowUp size={11} />
        </button>
        <button onClick={onMoveDown} disabled={idx === total - 1} className="rounded p-1 text-surface-300 hover:bg-surface-750 disabled:opacity-30">
          <ArrowDown size={11} />
        </button>
        <button onClick={onToggleEnabled} className="rounded px-1.5 py-0.5 text-[10px] text-surface-300 hover:bg-surface-750">
          {cand.enabled ? 'Disable' : 'Enable'}
        </button>
        <button onClick={onDelete} className="rounded px-1.5 py-0.5 text-[10px] text-error-300 hover:bg-error-500/10">
          <Trash2 size={11} />
        </button>
      </div>
    </div>
  );
}

function AddCandidateForm({
  connections,
  onAdd,
  nextPriority,
}: {
  connections: ApiConnectionDetail[];
  onAdd: (input: { connectionId: string; modelId: string; priority?: number; label?: string }) => Promise<boolean>;
  nextPriority: number;
}) {
  const [adding, setAdding] = useState(false);
  const [connId, setConnId] = useState('');
  const [modelId, setModelId] = useState('');
  const [label, setLabel] = useState('');

  const usableConns = connections.filter((c) => c.enabled && c.hasKey);
  const selectedConn = connections.find((c) => c.id === connId);

  async function handleAdd() {
    if (!connId || !modelId.trim()) return;
    const ok = await onAdd({ connectionId: connId, modelId: modelId.trim(), priority: nextPriority, label: label.trim() || undefined });
    if (ok) { setConnId(''); setModelId(''); setLabel(''); setAdding(false); }
  }

  if (!adding) {
    return (
      <button onClick={() => setAdding(true)} className="mt-2 flex items-center gap-1 text-2xs text-accent-400 hover:text-accent-300">
        <Plus size={12} /> Add candidate
      </button>
    );
  }

  return (
    <div className="mt-2 space-y-1.5 rounded bg-surface-800 p-2">
      {usableConns.length === 0 ? (
        <div className="text-2xs text-warning-300">
          No usable connections available. Create a connection with an API key and model first.
        </div>
      ) : (
        <>
          <div className="space-y-1">
            <label className="text-[10px] text-surface-300">Connection</label>
            <select
              value={connId}
              onChange={(e) => { setConnId(e.target.value); setModelId(''); }}
              className="w-full rounded-md border border-surface-600 bg-surface-800 px-2 py-1 text-2xs text-gray-100 focus:border-accent-500/50 focus:outline-none"
            >
              <option value="">Select a connection…</option>
              {usableConns.map((c) => (
                <option key={c.id} value={c.id}>{c.displayName}</option>
              ))}
            </select>
          </div>

          {selectedConn && selectedConn.models.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {selectedConn.models.filter((m) => m.enabled).map((m) => (
                <button
                  key={m.id}
                  onClick={() => setModelId(m.modelId)}
                  className={`rounded px-1.5 py-0.5 font-mono text-[10px] transition-colors ${
                    modelId === m.modelId ? 'bg-accent-500/20 text-accent-300' : 'bg-surface-850 text-surface-300 hover:bg-surface-750'
                  }`}
                >
                  {m.modelId}
                </button>
              ))}
            </div>
          )}

          <FieldInput label="Model ID" value={modelId} onChange={setModelId} placeholder="e.g. gemini-2.5-flash" mono />
          <FieldInput label="Label (optional)" value={label} onChange={setLabel} />
          <div className="flex gap-2">
            <Button variant="primary" size="sm" onClick={handleAdd} disabled={!connId || !modelId.trim()}>
              Add candidate
            </Button>
            <Button variant="ghost" size="sm" onClick={() => { setAdding(false); setConnId(''); setModelId(''); setLabel(''); }}>
              Cancel
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function CreateProfileForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (input: { name: string; description?: string }) => Promise<boolean>;
}) {
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <div className="space-y-2 rounded-md border border-accent-500/30 bg-surface-850 p-2.5">
      <div className="text-2xs font-semibold text-gray-200">New fallback profile</div>
      <FieldInput label="Name" value={name} onChange={setName} placeholder="e.g. Fast → Cheap fallback" />
      <FieldInput label="Description (optional)" value={desc} onChange={setDesc} placeholder="What this chain is for" />
      <div className="flex gap-2 pt-1">
        <Button
          variant="primary"
          size="sm"
          disabled={busy || !name.trim()}
          onClick={async () => {
            setBusy(true);
            await onSubmit({ name: name.trim(), description: desc.trim() || undefined });
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

function FieldInput({
  label, value, onChange, placeholder, mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <div className="space-y-1">
      <label className="text-[10px] text-surface-300">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full rounded-md border border-surface-600 bg-surface-800 px-2 py-1 text-2xs text-gray-100 placeholder:text-surface-400 focus:border-accent-500/50 focus:outline-none ${mono ? 'font-mono' : ''}`}
      />
    </div>
  );
}
