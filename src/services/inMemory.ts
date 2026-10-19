import type {
  Project,
  Conversation,
  ConversationMessage,
  ProviderConfig,
  AppSettings,
} from '@/types/domain';
import { DEFAULT_SETTINGS } from '@/types/domain';
import type { ProviderId } from '@/types';
import type {
  ProjectRepository,
  ConversationRepository,
  MessageRepository,
  ProviderConfigRepository,
  SettingsRepository,
  MemoryRepository,
  KnowledgeRepository,
  Repositories,
} from './repositories';
import type {
  Memory,
  KnowledgeEntry,
  MemoryCreateInput,
  MemoryUpdateInput,
  KnowledgeCreateInput,
  KnowledgeUpdateInput,
  MemoryListParams,
  KnowledgeListParams,
  ListResult,
  MemoryType,
  KnowledgeCategory,
} from '@/types/memory';
import { looksLikeSecret, normalizeTags, MEMORY_TYPES, KNOWLEDGE_CATEGORIES } from '@/types/memory';

/**
 * Browser-local fallback repositories. Used when no FastAPI backend is
 * configured (e.g. preview/development without the local Python service).
 *
 * Persistence: data is mirrored to localStorage so it survives reloads.
 * This is intentionally a single-source-of-truth store — there is no parallel
 * backend store to conflict with when `backendEnabled` is false.
 */

const KEYS = {
  projects: 'paide.projects',
  conversations: 'paide.conversations',
  messages: 'paide.messages',
  providers: 'paide.providers',
  settings: 'paide.settings',
} as const;

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / private mode — degrade silently; data stays in-memory for the session */
  }
}

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

class InMemoryProjectRepository implements ProjectRepository {
  private items: Project[] = load<Project[]>(KEYS.projects, []);

  private persist() {
    save(KEYS.projects, this.items);
  }

  async list(): Promise<Project[]> {
    return [...this.items].sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async get(id: string): Promise<Project | null> {
    return this.items.find((p) => p.id === id) ?? null;
  }
  async create(input: { name: string; path: string; template: string }): Promise<Project> {
    const now = Date.now();
    const p: Project = { id: uid('prj'), createdAt: now, updatedAt: now, ...input };
    this.items = [p, ...this.items];
    this.persist();
    return p;
  }
  async update(id: string, patch: Partial<Pick<Project, 'name' | 'path'>>): Promise<Project> {
    const p = this.items.find((x) => x.id === id);
    if (!p) throw new Error(`Project ${id} not found`);
    Object.assign(p, patch, { updatedAt: Date.now() });
    this.persist();
    return p;
  }
  async remove(id: string): Promise<void> {
    this.items = this.items.filter((p) => p.id !== id);
    this.persist();
  }
}

class InMemoryConversationRepository implements ConversationRepository {
  private items: Conversation[] = load<Conversation[]>(KEYS.conversations, []);

  private persist() {
    save(KEYS.conversations, this.items);
  }

  async list(projectId?: string | null): Promise<Conversation[]> {
    const filtered =
      projectId === undefined
        ? this.items
        : this.items.filter((c) => c.projectId === projectId);
    return [...filtered].sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async get(id: string): Promise<Conversation | null> {
    return this.items.find((c) => c.id === id) ?? null;
  }
  async create(input: { projectId: string | null; title: string }): Promise<Conversation> {
    const now = Date.now();
    const c: Conversation = { id: uid('cnv'), createdAt: now, updatedAt: now, ...input };
    this.items = [c, ...this.items];
    this.persist();
    return c;
  }
  async rename(id: string, title: string): Promise<Conversation> {
    const c = this.items.find((x) => x.id === id);
    if (!c) throw new Error(`Conversation ${id} not found`);
    c.title = title;
    c.updatedAt = Date.now();
    this.persist();
    return c;
  }
  async remove(id: string): Promise<void> {
    this.items = this.items.filter((c) => c.id !== id);
    this.persist();
  }
}

class InMemoryMessageRepository implements MessageRepository {
  private items: ConversationMessage[] = load<ConversationMessage[]>(KEYS.messages, []);

  private persist() {
    save(KEYS.messages, this.items);
  }

  async list(conversationId: string): Promise<ConversationMessage[]> {
    return this.items
      .filter((m) => m.conversationId === conversationId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }
  async append(input: {
    conversationId: string;
    role: ConversationMessage['role'];
    content: string;
    steps?: ConversationMessage['steps'];
  }): Promise<ConversationMessage> {
    const m: ConversationMessage = {
      id: uid('msg'),
      createdAt: Date.now(),
      ...input,
    };
    this.items = [...this.items, m];
    this.persist();
    return m;
  }
  async remove(id: string): Promise<void> {
    this.items = this.items.filter((m) => m.id !== id);
    this.persist();
  }
  async clear(conversationId: string): Promise<void> {
    this.items = this.items.filter((m) => m.conversationId !== conversationId);
    this.persist();
  }
}

const DEFAULT_PROVIDERS: ProviderConfig[] = [
  { id: 'gemini', enabled: true, model: 'gemini-2.0-flash', hasApiKey: false },
  { id: 'groq', enabled: false, model: 'llama-3.3-70b', hasApiKey: false },
  { id: 'cerebras', enabled: false, model: 'llama-3.1-8b', hasApiKey: false },
  { id: 'openrouter', enabled: false, model: 'auto', hasApiKey: false },
];

class InMemoryProviderConfigRepository implements ProviderConfigRepository {
  private items: ProviderConfig[] = load<ProviderConfig[]>(KEYS.providers, DEFAULT_PROVIDERS);

  private persist() {
    save(KEYS.providers, this.items);
  }

  async list(): Promise<ProviderConfig[]> {
    return [...this.items];
  }
  async get(id: string): Promise<ProviderConfig | null> {
    return this.items.find((p) => p.id === id) ?? null;
  }
  async upsert(input: {
    id: string;
    enabled: boolean;
    model: string;
    baseUrl?: string;
  }): Promise<ProviderConfig> {
    const id = input.id as ProviderId;
    const existing = this.items.find((p) => p.id === id);
    const next: ProviderConfig = existing
      ? { ...existing, ...input, id }
      : { ...input, id, hasApiKey: false };
    this.items = existing
      ? this.items.map((p) => (p.id === id ? next : p))
      : [...this.items, next];
    this.persist();
    return next;
  }
  async setApiKey(id: string, key: string | null): Promise<ProviderConfig> {
    const p = this.items.find((x) => x.id === id);
    if (!p) throw new Error(`Provider ${id} not found`);
    p.hasApiKey = Boolean(key);
    this.persist();
    return p;
  }
}

class InMemorySettingsRepository implements SettingsRepository {
  private settings: AppSettings = load<AppSettings>(KEYS.settings, DEFAULT_SETTINGS);

  private persist() {
    save(KEYS.settings, this.settings);
  }

  async get(): Promise<AppSettings> {
    return { ...this.settings };
  }
  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.settings = { ...this.settings, ...patch };
    this.persist();
    return this.settings;
  }
}

// --- Memory + Knowledge (Phase 7) ---

class InMemoryMemoryRepository implements MemoryRepository {
  private items: Memory[] = load<Memory[]>('paide.memories', []);

  private persist() {
    save('paide.memories', this.items);
  }

  async list(params: MemoryListParams = {}): Promise<ListResult<Memory>> {
    const {
      projectId,
      type,
      search,
      activeOnly = true,
      limit = 50,
      offset = 0,
    } = params;
    let filtered = this.items.slice();
    if (activeOnly) filtered = filtered.filter((m) => m.active);
    if (type) filtered = filtered.filter((m) => m.type === type);
    if (projectId === 'all') {
      // no project filter
    } else if (projectId === undefined || projectId === null) {
      filtered = filtered.filter((m) => m.projectId === null);
    } else {
      filtered = filtered.filter((m) => m.projectId === null || m.projectId === projectId);
    }
    if (search && search.trim()) {
      const q = search.toLowerCase();
      filtered = filtered.filter(
        (m) => m.title.toLowerCase().includes(q) || m.content.toLowerCase().includes(q),
      );
    }
    filtered.sort((a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt);
    const total = filtered.length;
    const items = filtered.slice(offset, offset + limit);
    return { items, total };
  }

  async get(id: string): Promise<Memory | null> {
    const m = this.items.find((x) => x.id === id);
    if (!m) return null;
    m.lastAccessedAt = Date.now();
    this.persist();
    return { ...m };
  }

  async create(input: MemoryCreateInput): Promise<Memory> {
    if (!MEMORY_TYPES.includes(input.type)) throw new Error(`Unknown memory type: ${input.type}`);
    if (!input.title.trim()) throw new Error('title is required');
    if (!input.content.trim()) throw new Error('content is required');
    if (looksLikeSecret(input.content) || looksLikeSecret(input.title)) {
      throw new Error('Refusing to store content that looks like a secret/credential.');
    }
    const now = Date.now();
    const m: Memory = {
      id: uid('mem'),
      type: input.type,
      title: input.title.trim(),
      content: input.content,
      projectId: input.projectId ?? null,
      tags: normalizeTags(input.tags),
      importance: input.importance ?? 0,
      active: true,
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: null,
    };
    this.items = [m, ...this.items];
    this.persist();
    return { ...m };
  }

  async update(id: string, patch: MemoryUpdateInput): Promise<Memory> {
    const m = this.items.find((x) => x.id === id);
    if (!m) throw new Error(`Memory ${id} not found`);
    if (patch.type !== undefined) {
      if (!MEMORY_TYPES.includes(patch.type as MemoryType)) throw new Error(`Unknown memory type: ${patch.type}`);
      m.type = patch.type;
    }
    if (patch.title !== undefined) {
      if (!patch.title.trim()) throw new Error('title is required');
      m.title = patch.title.trim();
    }
    if (patch.content !== undefined) {
      if (!patch.content.trim()) throw new Error('content is required');
      if (looksLikeSecret(patch.content)) throw new Error('Refusing to store content that looks like a secret.');
      m.content = patch.content;
    }
    if (patch.projectId !== undefined) m.projectId = patch.projectId ?? null;
    if (patch.tags !== undefined) m.tags = normalizeTags(patch.tags);
    if (patch.importance !== undefined) m.importance = patch.importance;
    if (patch.active !== undefined) m.active = patch.active;
    m.updatedAt = Date.now();
    this.persist();
    return { ...m };
  }

  async remove(id: string): Promise<void> {
    this.items = this.items.filter((m) => m.id !== id);
    this.persist();
  }
}

class InMemoryKnowledgeRepository implements KnowledgeRepository {
  private items: KnowledgeEntry[] = load<KnowledgeEntry[]>('paide.knowledge', []);

  private persist() {
    save('paide.knowledge', this.items);
  }

  async list(params: KnowledgeListParams = {}): Promise<ListResult<KnowledgeEntry>> {
    const {
      projectId,
      category,
      search,
      activeOnly = true,
      limit = 50,
      offset = 0,
    } = params;
    let filtered = this.items.slice();
    if (activeOnly) filtered = filtered.filter((k) => k.active);
    if (category) filtered = filtered.filter((k) => k.category === category);
    if (projectId === 'all') {
      // no filter
    } else if (projectId === undefined || projectId === null) {
      filtered = filtered.filter((k) => k.projectId === null);
    } else {
      filtered = filtered.filter((k) => k.projectId === null || k.projectId === projectId);
    }
    if (search && search.trim()) {
      const q = search.toLowerCase();
      filtered = filtered.filter(
        (k) => k.title.toLowerCase().includes(q) || k.content.toLowerCase().includes(q),
      );
    }
    filtered.sort((a, b) => b.updatedAt - a.updatedAt);
    const total = filtered.length;
    const items = filtered.slice(offset, offset + limit);
    return { items, total };
  }

  async get(id: string): Promise<KnowledgeEntry | null> {
    const k = this.items.find((x) => x.id === id);
    return k ? { ...k } : null;
  }

  async create(input: KnowledgeCreateInput): Promise<KnowledgeEntry> {
    if (!KNOWLEDGE_CATEGORIES.includes(input.category as KnowledgeCategory)) {
      throw new Error(`Unknown category: ${input.category}`);
    }
    if (!input.title.trim()) throw new Error('title is required');
    if (!input.content.trim()) throw new Error('content is required');
    if (looksLikeSecret(input.content) || looksLikeSecret(input.title)) {
      throw new Error('Refusing to store content that looks like a secret/credential.');
    }
    const now = Date.now();
    const k: KnowledgeEntry = {
      id: uid('kb'),
      title: input.title.trim(),
      content: input.content,
      category: input.category,
      projectId: input.projectId ?? null,
      tags: normalizeTags(input.tags),
      source: input.source ?? null,
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    this.items = [k, ...this.items];
    this.persist();
    return { ...k };
  }

  async update(id: string, patch: KnowledgeUpdateInput): Promise<KnowledgeEntry> {
    const k = this.items.find((x) => x.id === id);
    if (!k) throw new Error(`Knowledge ${id} not found`);
    if (patch.title !== undefined) {
      if (!patch.title.trim()) throw new Error('title is required');
      k.title = patch.title.trim();
    }
    if (patch.content !== undefined) {
      if (!patch.content.trim()) throw new Error('content is required');
      if (looksLikeSecret(patch.content)) throw new Error('Refusing to store content that looks like a secret.');
      k.content = patch.content;
    }
    if (patch.category !== undefined) {
      if (!KNOWLEDGE_CATEGORIES.includes(patch.category as KnowledgeCategory)) {
        throw new Error(`Unknown category: ${patch.category}`);
      }
      k.category = patch.category;
    }
    if (patch.projectId !== undefined) k.projectId = patch.projectId ?? null;
    if (patch.tags !== undefined) k.tags = normalizeTags(patch.tags);
    if (patch.source !== undefined) k.source = patch.source ? patch.source.trim() : null;
    if (patch.active !== undefined) k.active = patch.active;
    k.updatedAt = Date.now();
    this.persist();
    return { ...k };
  }

  async remove(id: string): Promise<void> {
    this.items = this.items.filter((k) => k.id !== id);
    this.persist();
  }
}

export const inMemoryRepositories: Repositories = {
  projects: new InMemoryProjectRepository(),
  conversations: new InMemoryConversationRepository(),
  messages: new InMemoryMessageRepository(),
  providers: new InMemoryProviderConfigRepository(),
  settings: new InMemorySettingsRepository(),
  memories: new InMemoryMemoryRepository(),
  knowledge: new InMemoryKnowledgeRepository(),
};
