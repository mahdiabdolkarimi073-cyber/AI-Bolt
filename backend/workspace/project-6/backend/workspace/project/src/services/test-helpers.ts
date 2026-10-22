import type { Repositories, ConversationRepository, MessageRepository, ProjectRepository, ProviderConfigRepository, SettingsRepository, MemoryRepository, KnowledgeRepository } from '@/services/repositories';
import type { Conversation, ConversationMessage, Project, ProviderConfig, AppSettings } from '@/types/domain';
import type { Memory, KnowledgeEntry, MemoryCreateInput, MemoryUpdateInput, KnowledgeCreateInput, KnowledgeUpdateInput, MemoryListParams, KnowledgeListParams, ListResult } from '@/types/memory';
import { looksLikeSecret, normalizeTags, MEMORY_TYPES, KNOWLEDGE_CATEGORIES } from '@/types/memory';
import type { ProviderId } from '@/types';

/** In-memory Repositories stub for tests. Deterministic, no I/O. */
export function createMockRepositories(): Repositories {
  const conversations = new Map<string, Conversation>();
  const messages = new Map<string, ConversationMessage>();
  const projects = new Map<string, Project>();
  const providers = new Map<string, ProviderConfig>();
  let settings: AppSettings = { activeProvider: 'gemini', activeProjectId: null, theme: 'dark', fontSize: 13, tabSize: 2 };
  let counter = 0;

  const messagesRepo: MessageRepository = {
    async list(conversationId) {
      return Array.from(messages.values())
        .filter((m) => m.conversationId === conversationId)
        .sort((a, b) => a.createdAt - b.createdAt);
    },
    async append(input) {
      const id = `msg-${++counter}`;
      const msg: ConversationMessage = {
        id,
        conversationId: input.conversationId,
        role: input.role,
        content: input.content,
        steps: input.steps,
        createdAt: Date.now(),
      };
      messages.set(id, msg);
      return msg;
    },
    async remove(id) {
      messages.delete(id);
    },
    async clear(conversationId) {
      for (const [id, m] of messages) {
        if (m.conversationId === conversationId) messages.delete(id);
      }
    },
  };

  const convRepo: ConversationRepository = {
    async list(projectId) {
      return Array.from(conversations.values())
        .filter((c) => (projectId === undefined ? true : c.projectId === projectId))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async get(id) {
      return conversations.get(id) ?? null;
    },
    async create(input) {
      const id = `cnv-${++counter}`;
      const ts = Date.now();
      const conv: Conversation = {
        id,
        projectId: input.projectId,
        title: input.title,
        createdAt: ts,
        updatedAt: ts,
      };
      conversations.set(id, conv);
      return conv;
    },
    async rename(id, title) {
      const c = conversations.get(id)!;
      const updated = { ...c, title, updatedAt: Date.now() };
      conversations.set(id, updated);
      return updated;
    },
    async remove(id) {
      conversations.delete(id);
    },
  };

  const projRepo: ProjectRepository = {
    async list() { return Array.from(projects.values()); },
    async get(id) { return projects.get(id) ?? null; },
    async create(input) {
      const id = `prj-${++counter}`;
      const ts = Date.now();
      const p: Project = { id, name: input.name, path: input.path, template: input.template, createdAt: ts, updatedAt: ts };
      projects.set(id, p);
      return p;
    },
    async update(id, patch) {
      const p = projects.get(id)!;
      const updated = { ...p, ...patch, updatedAt: Date.now() };
      projects.set(id, updated);
      return updated;
    },
    async remove(id) { projects.delete(id); },
  };

  const provRepo: ProviderConfigRepository = {
    async list() { return Array.from(providers.values()); },
    async get(id) { return providers.get(id) ?? null; },
    async upsert(input) {
      const existing = providers.get(input.id);
      const cfg: ProviderConfig = {
        id: input.id as ProviderId,
        enabled: input.enabled,
        model: input.model,
        baseUrl: input.baseUrl ?? existing?.baseUrl ?? undefined,
        hasApiKey: existing?.hasApiKey ?? false,
      };
      providers.set(input.id, cfg);
      return cfg;
    },
    async setApiKey(id, key) {
      const cfg = providers.get(id) ?? { id: id as ProviderId, enabled: false, model: 'default', baseUrl: undefined, hasApiKey: false };
      const updated = { ...cfg, hasApiKey: key !== null };
      providers.set(id, updated);
      return updated;
    },
  };

  const settingsRepo: SettingsRepository = {
    async get() { return settings; },
    async update(patch) { settings = { ...settings, ...patch }; return settings; },
  };

  // --- Memory + Knowledge stubs (Phase 7) ---
  const memories = new Map<string, Memory>();
  const knowledge = new Map<string, KnowledgeEntry>();
  let memCounter = 0;
  let kbCounter = 0;

  const memoriesRepo: MemoryRepository = {
    async list(params: MemoryListParams = {}): Promise<ListResult<Memory>> {
      let filtered = Array.from(memories.values());
      if (params.activeOnly !== false) filtered = filtered.filter((m) => m.active);
      if (params.type) filtered = filtered.filter((m) => m.type === params.type);
      if (params.projectId === 'all') {
        // no filter
      } else if (params.projectId === undefined || params.projectId === null) {
        filtered = filtered.filter((m) => m.projectId === null);
      } else {
        filtered = filtered.filter((m) => m.projectId === null || m.projectId === params.projectId);
      }
      if (params.search) {
        const q = params.search.toLowerCase();
        filtered = filtered.filter((m) => m.title.toLowerCase().includes(q) || m.content.toLowerCase().includes(q));
      }
      filtered.sort((a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt);
      const total = filtered.length;
      const limit = params.limit ?? 50;
      const offset = params.offset ?? 0;
      return { items: filtered.slice(offset, offset + limit), total };
    },
    async get(id) { return memories.get(id) ?? null; },
    async create(input: MemoryCreateInput): Promise<Memory> {
      if (!MEMORY_TYPES.includes(input.type)) throw new Error(`Unknown memory type: ${input.type}`);
      if (looksLikeSecret(input.content)) throw new Error('Refusing to store content that looks like a secret.');
      const id = `mem-${++memCounter}`;
      const ts = Date.now();
      const m: Memory = {
        id, type: input.type, title: input.title.trim(), content: input.content,
        projectId: input.projectId ?? null, tags: normalizeTags(input.tags),
        importance: input.importance ?? 0, active: true, createdAt: ts, updatedAt: ts, lastAccessedAt: null,
      };
      memories.set(id, m);
      return { ...m };
    },
    async update(id, patch: MemoryUpdateInput): Promise<Memory> {
      const m = memories.get(id);
      if (!m) throw new Error(`Memory ${id} not found`);
      if (patch.type !== undefined) m.type = patch.type;
      if (patch.title !== undefined) m.title = patch.title.trim();
      if (patch.content !== undefined) {
        if (looksLikeSecret(patch.content)) throw new Error('Refusing to store content that looks like a secret.');
        m.content = patch.content;
      }
      if (patch.projectId !== undefined) m.projectId = patch.projectId ?? null;
      if (patch.tags !== undefined) m.tags = normalizeTags(patch.tags);
      if (patch.importance !== undefined) m.importance = patch.importance;
      if (patch.active !== undefined) m.active = patch.active;
      m.updatedAt = Date.now();
      memories.set(id, { ...m });
      return { ...m };
    },
    async remove(id) { memories.delete(id); },
  };

  const knowledgeRepo: KnowledgeRepository = {
    async list(params: KnowledgeListParams = {}): Promise<ListResult<KnowledgeEntry>> {
      let filtered = Array.from(knowledge.values());
      if (params.activeOnly !== false) filtered = filtered.filter((k) => k.active);
      if (params.category) filtered = filtered.filter((k) => k.category === params.category);
      if (params.projectId === 'all') {
        // no filter
      } else if (params.projectId === undefined || params.projectId === null) {
        filtered = filtered.filter((k) => k.projectId === null);
      } else {
        filtered = filtered.filter((k) => k.projectId === null || k.projectId === params.projectId);
      }
      if (params.search) {
        const q = params.search.toLowerCase();
        filtered = filtered.filter((k) => k.title.toLowerCase().includes(q) || k.content.toLowerCase().includes(q));
      }
      filtered.sort((a, b) => b.updatedAt - a.updatedAt);
      const total = filtered.length;
      const limit = params.limit ?? 50;
      const offset = params.offset ?? 0;
      return { items: filtered.slice(offset, offset + limit), total };
    },
    async get(id) { return knowledge.get(id) ?? null; },
    async create(input: KnowledgeCreateInput): Promise<KnowledgeEntry> {
      if (!KNOWLEDGE_CATEGORIES.includes(input.category)) throw new Error(`Unknown category: ${input.category}`);
      if (looksLikeSecret(input.content)) throw new Error('Refusing to store content that looks like a secret.');
      const id = `kb-${++kbCounter}`;
      const ts = Date.now();
      const k: KnowledgeEntry = {
        id, title: input.title.trim(), content: input.content, category: input.category,
        projectId: input.projectId ?? null, tags: normalizeTags(input.tags),
        source: input.source ?? null, active: true, createdAt: ts, updatedAt: ts,
      };
      knowledge.set(id, k);
      return { ...k };
    },
    async update(id, patch: KnowledgeUpdateInput): Promise<KnowledgeEntry> {
      const k = knowledge.get(id);
      if (!k) throw new Error(`Knowledge ${id} not found`);
      if (patch.title !== undefined) k.title = patch.title.trim();
      if (patch.content !== undefined) {
        if (looksLikeSecret(patch.content)) throw new Error('Refusing to store content that looks like a secret.');
        k.content = patch.content;
      }
      if (patch.category !== undefined) k.category = patch.category;
      if (patch.projectId !== undefined) k.projectId = patch.projectId ?? null;
      if (patch.tags !== undefined) k.tags = normalizeTags(patch.tags);
      if (patch.source !== undefined) k.source = patch.source ? patch.source.trim() : null;
      if (patch.active !== undefined) k.active = patch.active;
      k.updatedAt = Date.now();
      knowledge.set(id, { ...k });
      return { ...k };
    },
    async remove(id) { knowledge.delete(id); },
  };

  return { projects: projRepo, conversations: convRepo, messages: messagesRepo, providers: provRepo, settings: settingsRepo, memories: memoriesRepo, knowledge: knowledgeRepo };
}
