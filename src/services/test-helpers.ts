import type { Repositories, ConversationRepository, MessageRepository, ProjectRepository, ProviderConfigRepository, SettingsRepository } from '@/services/repositories';
import type { Conversation, ConversationMessage, Project, ProviderConfig, AppSettings } from '@/types/domain';
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

  return { projects: projRepo, conversations: convRepo, messages: messagesRepo, providers: provRepo, settings: settingsRepo };
}
