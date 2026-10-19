import { useCallback, useEffect, useState } from 'react';
import {
  Plus,
  Trash2,
  Loader2,
  AlertCircle,
  Brain,
  BookOpen,
  Search,
  Pencil,
  X,
  Check,
} from 'lucide-react';
import { Button } from './ui/Button';
import {
  listMemories,
  createMemory,
  updateMemory,
  deleteMemory,
  listKnowledge,
  createKnowledge,
  updateKnowledge,
  deleteKnowledge,
} from '@/services/memoryService';
import {
  MEMORY_TYPES,
  MEMORY_TYPE_LABELS,
  KNOWLEDGE_CATEGORIES,
  KNOWLEDGE_CATEGORY_LABELS,
  type Memory,
  type KnowledgeEntry,
  type MemoryType,
  type KnowledgeCategory,
  type MemoryCreateInput,
  type KnowledgeCreateInput,
} from '@/types/memory';

type Tab = 'memories' | 'knowledge';

export function MemoryPanel() {
  const [tab, setTab] = useState<Tab>('memories');

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1 rounded-md bg-surface-800 p-0.5">
        <TabButton active={tab === 'memories'} onClick={() => setTab('memories')} icon={<Brain size={13} />}>
          Memories
        </TabButton>
        <TabButton active={tab === 'knowledge'} onClick={() => setTab('knowledge')} icon={<BookOpen size={13} />}>
          Knowledge
        </TabButton>
      </div>

      <div className="rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-2xs text-surface-300">
        Memories are personal/general durable facts that apply across projects. Knowledge is
        project-scoped documentation. Both are injected into the AI&apos;s context as reference
        material when relevant to your message.
      </div>

      {tab === 'memories' ? <MemoriesSection /> : <KnowledgeSection />}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1.5 text-2xs font-medium transition-colors ${
        active ? 'bg-surface-650 text-gray-100' : 'text-surface-300 hover:text-gray-200'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

// --- Memories section ---

function MemoriesSection() {
  const [items, setItems] = useState<Memory[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState<'all' | 'personal' | ''>('all');
  const [typeFilter, setTypeFilter] = useState<MemoryType | ''>('');
  const [editing, setEditing] = useState<Memory | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error } = await listMemories({
      projectId: scope === 'all' ? 'all' : scope === 'personal' ? null : scope,
      search: search.trim() || undefined,
      type: typeFilter || undefined,
      activeOnly: false,
      limit: 100,
    });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    setItems(data?.items ?? []);
    setTotal(data?.total ?? 0);
  }, [scope, search, typeFilter]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function handleDelete(id: string, title: string) {
    if (!confirm(`Delete memory "${title}"?`)) return;
    const { error } = await deleteMemory(id);
    if (error) {
      setError(error.message);
      return;
    }
    await reload();
  }

  async function handleToggleActive(m: Memory) {
    const { error } = await updateMemory(m.id, { active: !m.active });
    if (error) {
      setError(error.message);
      return;
    }
    await reload();
  }

  return (
    <div className="space-y-2.5">
      {error && (
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-surface-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search memories…"
            className="w-full rounded-md border border-surface-600 bg-surface-850 py-1.5 pl-7 pr-2 text-2xs text-gray-100 placeholder:text-surface-400 focus:border-accent-500/50 focus:outline-none"
          />
        </div>
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as 'all' | 'personal' | '')}
          className="rounded-md border border-surface-600 bg-surface-850 px-2 py-1.5 text-2xs text-gray-100 focus:border-accent-500/50 focus:outline-none"
        >
          <option value="all">All scopes</option>
          <option value="personal">Personal</option>
        </select>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as MemoryType | '')}
          className="rounded-md border border-surface-600 bg-surface-850 px-2 py-1.5 text-2xs text-gray-100 focus:border-accent-500/50 focus:outline-none"
        >
          <option value="">All types</option>
          {MEMORY_TYPES.map((t) => (
            <option key={t} value={t}>{MEMORY_TYPE_LABELS[t]}</option>
          ))}
        </select>
        <Button variant="primary" size="sm" onClick={() => setShowCreate(true)} disabled={showCreate || editing !== null}>
          <Plus size={13} className="mr-1" /> New
        </Button>
      </div>

      {showCreate && (
        <MemoryForm
          onCancel={() => setShowCreate(false)}
          onSaved={async () => {
            setShowCreate(false);
            await reload();
          }}
        />
      )}

      {editing && (
        <MemoryForm
          initial={editing}
          onCancel={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      )}

      {loading ? (
        <LoadingRow label="Loading memories…" />
      ) : items.length === 0 ? (
        <EmptyRow
          label={search || typeFilter ? 'No memories match your filters.' : 'No memories yet. Create one to give the AI persistent context.'}
        />
      ) : (
        <div className="space-y-1.5">
          <div className="text-[10px] text-surface-400">{total} total</div>
          {items.map((m) => (
            <MemoryCard
              key={m.id}
              memory={m}
              onEdit={() => setEditing(m)}
              onDelete={() => handleDelete(m.id, m.title)}
              onToggleActive={() => handleToggleActive(m)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function MemoryCard({
  memory,
  onEdit,
  onDelete,
  onToggleActive,
}: {
  memory: Memory;
  onEdit: () => void;
  onDelete: () => void;
  onToggleActive: () => void;
}) {
  return (
    <div className={`rounded-md border p-2.5 transition-colors ${memory.active ? 'border-surface-700 bg-surface-800' : 'border-surface-700 bg-surface-850 opacity-60'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-xs font-semibold text-gray-100">{memory.title}</span>
            <span className="rounded-full bg-surface-700 px-1.5 py-0.5 text-[10px] text-surface-300">
              {MEMORY_TYPE_LABELS[memory.type]}
            </span>
            {memory.projectId && (
              <span className="rounded-full bg-accent-500/15 px-1.5 py-0.5 text-[10px] text-accent-300">project</span>
            )}
            {!memory.active && (
              <span className="rounded-full bg-surface-700 px-1.5 py-0.5 text-[10px] text-surface-400">inactive</span>
            )}
            {memory.importance !== 0 && (
              <span className="text-[10px] text-surface-400">★ {memory.importance}</span>
            )}
          </div>
          <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-2xs text-surface-300">{memory.content}</p>
          {memory.tags.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {memory.tags.map((t) => (
                <span key={t} className="rounded bg-surface-750 px-1 py-0.5 text-[10px] text-surface-400">#{t}</span>
              ))}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <IconAction title="Edit" onClick={onEdit}>
            <Pencil size={12} />
          </IconAction>
          <IconAction title={memory.active ? 'Deactivate' : 'Activate'} onClick={onToggleActive}>
            {memory.active ? <X size={12} /> : <Check size={12} />}
          </IconAction>
          <IconAction title="Delete" onClick={onDelete} danger>
            <Trash2 size={12} />
          </IconAction>
        </div>
      </div>
    </div>
  );
}

function MemoryForm({
  initial,
  onCancel,
  onSaved,
}: {
  initial?: Memory;
  onCancel: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [type, setType] = useState<MemoryType>(initial?.type ?? 'note');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [content, setContent] = useState(initial?.content ?? '');
  const [tags, setTags] = useState(initial?.tags.join(', ') ?? '');
  const [importance, setImportance] = useState(initial?.importance ?? 0);
  const [projectId, setProjectId] = useState(initial?.projectId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!title.trim() || !content.trim()) return;
    setBusy(true);
    setError(null);
    const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean);
    if (initial) {
      const { error } = await updateMemory(initial.id, {
        type,
        title: title.trim(),
        content: content.trim(),
        tags: tagList,
        importance,
        projectId: projectId.trim() || null,
      });
      setBusy(false);
      if (error) {
        setError(error.message);
        return;
      }
      await onSaved();
    } else {
      const input: MemoryCreateInput = {
        type,
        title: title.trim(),
        content: content.trim(),
        tags: tagList,
        importance,
        projectId: projectId.trim() || null,
      };
      const { error } = await createMemory(input);
      setBusy(false);
      if (error) {
        setError(error.message);
        return;
      }
      await onSaved();
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-accent-500/30 bg-surface-850 p-2.5">
      <div className="text-2xs font-semibold text-gray-200">{initial ? 'Edit memory' : 'New memory'}</div>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <div className="grid grid-cols-2 gap-2">
        <FieldInput label="Title" value={title} onChange={setTitle} placeholder="Short label" />
        <div className="space-y-1">
          <label className="text-[10px] text-surface-300">Type</label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as MemoryType)}
            className="w-full rounded-md border border-surface-600 bg-surface-800 px-2 py-1 text-2xs text-gray-100 focus:border-accent-500/50 focus:outline-none"
          >
            {MEMORY_TYPES.map((t) => (
              <option key={t} value={t}>{MEMORY_TYPE_LABELS[t]}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="space-y-1">
        <label className="text-[10px] text-surface-300">Content</label>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={4}
          placeholder="The fact, preference, or note to remember…"
          className="w-full rounded-md border border-surface-600 bg-surface-800 px-2 py-1.5 text-2xs text-gray-100 placeholder:text-surface-400 focus:border-accent-500/50 focus:outline-none"
        />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <FieldInput label="Tags (comma separated)" value={tags} onChange={setTags} placeholder="python, frontend" />
        <div className="space-y-1">
          <label className="text-[10px] text-surface-300">Importance (-5..10)</label>
          <input
            type="number"
            min={-5}
            max={10}
            value={importance}
            onChange={(e) => setImportance(Number(e.target.value))}
            className="w-full rounded-md border border-surface-600 bg-surface-800 px-2 py-1 text-2xs text-gray-100 focus:border-accent-500/50 focus:outline-none"
          />
        </div>
        <FieldInput label="Project id (optional)" value={projectId} onChange={setProjectId} placeholder="leave blank for personal" />
      </div>
      <div className="flex gap-2 pt-1">
        <Button variant="primary" size="sm" disabled={busy || !title.trim() || !content.trim()} onClick={submit}>
          {busy && <Loader2 size={13} className="mr-1 animate-spin" />}
          {initial ? 'Save' : 'Create'}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

// --- Knowledge section ---

function KnowledgeSection() {
  const [items, setItems] = useState<KnowledgeEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState<'all' | 'global' | ''>('all');
  const [categoryFilter, setCategoryFilter] = useState<KnowledgeCategory | ''>('');
  const [editing, setEditing] = useState<KnowledgeEntry | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error } = await listKnowledge({
      projectId: scope === 'all' ? 'all' : scope === 'global' ? null : scope,
      search: search.trim() || undefined,
      category: categoryFilter || undefined,
      activeOnly: false,
      limit: 100,
    });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    setItems(data?.items ?? []);
    setTotal(data?.total ?? 0);
  }, [scope, search, categoryFilter]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function handleDelete(id: string, title: string) {
    if (!confirm(`Delete knowledge entry "${title}"?`)) return;
    const { error } = await deleteKnowledge(id);
    if (error) {
      setError(error.message);
      return;
    }
    await reload();
  }

  async function handleToggleActive(k: KnowledgeEntry) {
    const { error } = await updateKnowledge(k.id, { active: !k.active });
    if (error) {
      setError(error.message);
      return;
    }
    await reload();
  }

  return (
    <div className="space-y-2.5">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-surface-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search knowledge…"
            className="w-full rounded-md border border-surface-600 bg-surface-850 py-1.5 pl-7 pr-2 text-2xs text-gray-100 placeholder:text-surface-400 focus:border-accent-500/50 focus:outline-none"
          />
        </div>
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as 'all' | 'global' | '')}
          className="rounded-md border border-surface-600 bg-surface-850 px-2 py-1.5 text-2xs text-gray-100 focus:border-accent-500/50 focus:outline-none"
        >
          <option value="all">All scopes</option>
          <option value="global">Global only</option>
        </select>
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value as KnowledgeCategory | '')}
          className="rounded-md border border-surface-600 bg-surface-850 px-2 py-1.5 text-2xs text-gray-100 focus:border-accent-500/50 focus:outline-none"
        >
          <option value="">All categories</option>
          {KNOWLEDGE_CATEGORIES.map((c) => (
            <option key={c} value={c}>{KNOWLEDGE_CATEGORY_LABELS[c]}</option>
          ))}
        </select>
        <Button variant="primary" size="sm" onClick={() => setShowCreate(true)} disabled={showCreate || editing !== null}>
          <Plus size={13} className="mr-1" /> New
        </Button>
      </div>

      {showCreate && (
        <KnowledgeForm
          onCancel={() => setShowCreate(false)}
          onSaved={async () => {
            setShowCreate(false);
            await reload();
          }}
        />
      )}

      {editing && (
        <KnowledgeForm
          initial={editing}
          onCancel={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      )}

      {loading ? (
        <LoadingRow label="Loading knowledge…" />
      ) : items.length === 0 ? (
        <EmptyRow
          label={search || categoryFilter ? 'No entries match your filters.' : 'No knowledge entries yet. Add project-scoped docs, summaries, or conventions.'}
        />
      ) : (
        <div className="space-y-1.5">
          <div className="text-[10px] text-surface-400">{total} total</div>
          {items.map((k) => (
            <KnowledgeCard
              key={k.id}
              entry={k}
              onEdit={() => setEditing(k)}
              onDelete={() => handleDelete(k.id, k.title)}
              onToggleActive={() => handleToggleActive(k)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function KnowledgeCard({
  entry,
  onEdit,
  onDelete,
  onToggleActive,
}: {
  entry: KnowledgeEntry;
  onEdit: () => void;
  onDelete: () => void;
  onToggleActive: () => void;
}) {
  return (
    <div className={`rounded-md border p-2.5 transition-colors ${entry.active ? 'border-surface-700 bg-surface-800' : 'border-surface-700 bg-surface-850 opacity-60'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-xs font-semibold text-gray-100">{entry.title}</span>
            <span className="rounded-full bg-surface-700 px-1.5 py-0.5 text-[10px] text-surface-300">
              {KNOWLEDGE_CATEGORY_LABELS[entry.category]}
            </span>
            {entry.projectId && (
              <span className="rounded-full bg-accent-500/15 px-1.5 py-0.5 text-[10px] text-accent-300">project</span>
            )}
            {!entry.active && (
              <span className="rounded-full bg-surface-700 px-1.5 py-0.5 text-[10px] text-surface-400">inactive</span>
            )}
            {entry.source && (
              <span className="truncate text-[10px] text-surface-400">src: {entry.source}</span>
            )}
          </div>
          <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-2xs text-surface-300">{entry.content}</p>
          {entry.tags.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {entry.tags.map((t) => (
                <span key={t} className="rounded bg-surface-750 px-1 py-0.5 text-[10px] text-surface-400">#{t}</span>
              ))}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <IconAction title="Edit" onClick={onEdit}>
            <Pencil size={12} />
          </IconAction>
          <IconAction title={entry.active ? 'Deactivate' : 'Activate'} onClick={onToggleActive}>
            {entry.active ? <X size={12} /> : <Check size={12} />}
          </IconAction>
          <IconAction title="Delete" onClick={onDelete} danger>
            <Trash2 size={12} />
          </IconAction>
        </div>
      </div>
    </div>
  );
}

function KnowledgeForm({
  initial,
  onCancel,
  onSaved,
}: {
  initial?: KnowledgeEntry;
  onCancel: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [content, setContent] = useState(initial?.content ?? '');
  const [category, setCategory] = useState<KnowledgeCategory>(initial?.category ?? 'note');
  const [tags, setTags] = useState(initial?.tags.join(', ') ?? '');
  const [source, setSource] = useState(initial?.source ?? '');
  const [projectId, setProjectId] = useState(initial?.projectId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!title.trim() || !content.trim()) return;
    setBusy(true);
    setError(null);
    const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean);
    if (initial) {
      const { error } = await updateKnowledge(initial.id, {
        title: title.trim(),
        content: content.trim(),
        category,
        tags: tagList,
        source: source.trim() || null,
        projectId: projectId.trim() || null,
      });
      setBusy(false);
      if (error) {
        setError(error.message);
        return;
      }
      await onSaved();
    } else {
      const input: KnowledgeCreateInput = {
        title: title.trim(),
        content: content.trim(),
        category,
        tags: tagList,
        source: source.trim() || null,
        projectId: projectId.trim() || null,
      };
      const { error } = await createKnowledge(input);
      setBusy(false);
      if (error) {
        setError(error.message);
        return;
      }
      await onSaved();
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-accent-500/30 bg-surface-850 p-2.5">
      <div className="text-2xs font-semibold text-gray-200">{initial ? 'Edit knowledge' : 'New knowledge entry'}</div>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <div className="grid grid-cols-2 gap-2">
        <FieldInput label="Title" value={title} onChange={setTitle} placeholder="Short label" />
        <div className="space-y-1">
          <label className="text-[10px] text-surface-300">Category</label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as KnowledgeCategory)}
            className="w-full rounded-md border border-surface-600 bg-surface-800 px-2 py-1 text-2xs text-gray-100 focus:border-accent-500/50 focus:outline-none"
          >
            {KNOWLEDGE_CATEGORIES.map((c) => (
              <option key={c} value={c}>{KNOWLEDGE_CATEGORY_LABELS[c]}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="space-y-1">
        <label className="text-[10px] text-surface-300">Content</label>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={5}
          placeholder="Architecture notes, conventions, limitations…"
          className="w-full rounded-md border border-surface-600 bg-surface-800 px-2 py-1.5 text-2xs text-gray-100 placeholder:text-surface-400 focus:border-accent-500/50 focus:outline-none"
        />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <FieldInput label="Tags (comma separated)" value={tags} onChange={setTags} placeholder="api, auth" />
        <FieldInput label="Source (optional)" value={source} onChange={setSource} placeholder="docs/url" />
        <FieldInput label="Project id (optional)" value={projectId} onChange={setProjectId} placeholder="leave blank for global" />
      </div>
      <div className="flex gap-2 pt-1">
        <Button variant="primary" size="sm" disabled={busy || !title.trim() || !content.trim()} onClick={submit}>
          {busy && <Loader2 size={13} className="mr-1 animate-spin" />}
          {initial ? 'Save' : 'Create'}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

// --- Shared small components ---

function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-error-500/40 bg-error-500/10 px-3 py-2 text-2xs text-error-300">
      <AlertCircle size={14} className="mt-0.5 shrink-0" />
      <span className="flex-1">{message}</span>
      <button onClick={onDismiss} className="text-error-300 hover:text-error-200">Dismiss</button>
    </div>
  );
}

function LoadingRow({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-4 text-2xs text-surface-300">
      <Loader2 size={14} className="animate-spin" /> {label}
    </div>
  );
}

function EmptyRow({ label }: { label: string }) {
  return <div className="py-4 text-center text-2xs text-surface-400">{label}</div>;
}

function IconAction({
  title,
  onClick,
  children,
  danger,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={`rounded p-1 text-surface-300 transition-colors hover:bg-surface-750 ${
        danger ? 'hover:text-error-300' : 'hover:text-gray-100'
      }`}
    >
      {children}
    </button>
  );
}

function FieldInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1">
      <label className="text-[10px] text-surface-300">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-md border border-surface-600 bg-surface-800 px-2 py-1 text-2xs text-gray-100 placeholder:text-surface-400 focus:border-accent-500/50 focus:outline-none"
      />
    </div>
  );
}
