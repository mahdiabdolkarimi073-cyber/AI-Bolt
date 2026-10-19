import { request } from '@/lib/http';
import type {
  Project,
  Conversation,
  ConversationMessage,
  ProviderConfig,
  AppSettings,
} from '@/types/domain';
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
} from '@/types/memory';

/**
 * Backend-backed repositories. These talk to the local FastAPI service.
 * Each method returns the data on success or throws an Error on failure —
 * callers should wrap in try/catch and surface a visible error state.
 *
 * API keys are sent to the backend only via the dedicated `setApiKey` endpoint
 * and never read back.
 */

class BackendProjectRepository implements ProjectRepository {
  async list(): Promise<Project[]> {
    const { data, error } = await request<Project[]>('/projects');
    if (error) throw new Error(error.message);
    return data ?? [];
  }
  async get(id: string): Promise<Project | null> {
    const { data, error } = await request<Project>(`/projects/${encodeURIComponent(id)}`);
    if (error) throw new Error(error.message);
    return data;
  }
  async create(input: {
    name: string;
    path: string;
    template: string;
    workspacePath?: string;
    importSource?: string;
  }): Promise<Project> {
    const { data, error } = await request<Project>('/projects', { method: 'POST', body: input });
    if (error) throw new Error(error.message);
    if (!data) throw new Error('Empty response from backend');
    return data;
  }
  async update(id: string, patch: Partial<Pick<Project, 'name' | 'path' | 'workspacePath'>>): Promise<Project> {
    const { data, error } = await request<Project>(`/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: patch,
    });
    if (error) throw new Error(error.message);
    if (!data) throw new Error('Empty response from backend');
    return data;
  }
  async remove(id: string): Promise<void> {
    const { error } = await request<void>(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (error) throw new Error(error.message);
  }
}

class BackendConversationRepository implements ConversationRepository {
  async list(projectId?: string | null): Promise<Conversation[]> {
    const qs = projectId !== undefined ? `?projectId=${encodeURIComponent(projectId ?? '')}` : '';
    const { data, error } = await request<Conversation[]>(`/conversations${qs}`);
    if (error) throw new Error(error.message);
    return data ?? [];
  }
  async get(id: string): Promise<Conversation | null> {
    const { data, error } = await request<Conversation>(`/conversations/${encodeURIComponent(id)}`);
    if (error) throw new Error(error.message);
    return data;
  }
  async create(input: { projectId: string | null; title: string }): Promise<Conversation> {
    const { data, error } = await request<Conversation>('/conversations', {
      method: 'POST',
      body: input,
    });
    if (error) throw new Error(error.message);
    if (!data) throw new Error('Empty response from backend');
    return data;
  }
  async rename(id: string, title: string): Promise<Conversation> {
    const { data, error } = await request<Conversation>(
      `/conversations/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: { title } },
    );
    if (error) throw new Error(error.message);
    if (!data) throw new Error('Empty response from backend');
    return data;
  }
  async remove(id: string): Promise<void> {
    const { error } = await request<void>(`/conversations/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (error) throw new Error(error.message);
  }
}

class BackendMessageRepository implements MessageRepository {
  async list(conversationId: string): Promise<ConversationMessage[]> {
    const { data, error } = await request<ConversationMessage[]>(
      `/conversations/${encodeURIComponent(conversationId)}/messages`,
    );
    if (error) throw new Error(error.message);
    return data ?? [];
  }
  async append(input: {
    conversationId: string;
    role: ConversationMessage['role'];
    content: string;
    steps?: ConversationMessage['steps'];
  }): Promise<ConversationMessage> {
    const { data, error } = await request<ConversationMessage>(
      `/conversations/${encodeURIComponent(input.conversationId)}/messages`,
      { method: 'POST', body: input },
    );
    if (error) throw new Error(error.message);
    if (!data) throw new Error('Empty response from backend');
    return data;
  }
  async remove(id: string): Promise<void> {
    const { error } = await request<void>(`/messages/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (error) throw new Error(error.message);
  }
  async clear(conversationId: string): Promise<void> {
    const { error } = await request<void>(
      `/conversations/${encodeURIComponent(conversationId)}/messages`,
      { method: 'DELETE',
    });
    if (error) throw new Error(error.message);
  }
}

class BackendProviderConfigRepository implements ProviderConfigRepository {
  async list(): Promise<ProviderConfig[]> {
    const { data, error } = await request<ProviderConfig[]>('/providers');
    if (error) throw new Error(error.message);
    return data ?? [];
  }
  async get(id: string): Promise<ProviderConfig | null> {
    const { data, error } = await request<ProviderConfig>(`/providers/${encodeURIComponent(id)}`);
    if (error) throw new Error(error.message);
    return data;
  }
  async upsert(input: {
    id: string;
    enabled: boolean;
    model: string;
    baseUrl?: string;
  }): Promise<ProviderConfig> {
    const { data, error } = await request<ProviderConfig>(`/providers/${encodeURIComponent(input.id)}`, {
      method: 'PUT',
      body: { enabled: input.enabled, model: input.model, baseUrl: input.baseUrl },
    });
    if (error) throw new Error(error.message);
    if (!data) throw new Error('Empty response from backend');
    return data;
  }
  async setApiKey(id: string, key: string | null): Promise<ProviderConfig> {
    const { data, error } = await request<ProviderConfig>(
      `/providers/${encodeURIComponent(id)}/api-key`,
      { method: 'POST', body: { key } },
    );
    if (error) throw new Error(error.message);
    if (!data) throw new Error('Empty response from backend');
    return data;
  }
}

class BackendSettingsRepository implements SettingsRepository {
  async get(): Promise<AppSettings> {
    const { data, error } = await request<AppSettings>('/settings');
    if (error) throw new Error(error.message);
    if (!data) throw new Error('Empty response from backend');
    return data;
  }
  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const { data, error } = await request<AppSettings>('/settings', { method: 'PATCH', body: patch });
    if (error) throw new Error(error.message);
    if (!data) throw new Error('Empty response from backend');
    return data;
  }
}

class BackendMemoryRepository implements MemoryRepository {
  private buildQuery(params: MemoryListParams = {}): string {
    const qs: string[] = [];
    if (params.projectId !== undefined) qs.push(`projectId=${encodeURIComponent(params.projectId ?? '')}`);
    if (params.type) qs.push(`type=${encodeURIComponent(params.type)}`);
    if (params.search) qs.push(`search=${encodeURIComponent(params.search)}`);
    if (params.activeOnly !== undefined) qs.push(`activeOnly=${String(params.activeOnly)}`);
    if (params.limit !== undefined) qs.push(`limit=${String(params.limit)}`);
    if (params.offset !== undefined) qs.push(`offset=${String(params.offset)}`);
    return qs.length ? `?${qs.join('&')}` : '';
  }
  async list(params: MemoryListParams = {}): Promise<ListResult<Memory>> {
    const { data, error } = await request<ListResult<Memory>>(`/memory${this.buildQuery(params)}`);
    if (error) throw new Error(error.message);
    return data ?? { items: [], total: 0 };
  }
  async get(id: string): Promise<Memory | null> {
    const { data, error } = await request<Memory>(`/memory/${encodeURIComponent(id)}`);
    if (error) throw new Error(error.message);
    return data;
  }
  async create(input: MemoryCreateInput): Promise<Memory> {
    const { data, error } = await request<Memory>('/memory', { method: 'POST', body: input });
    if (error) throw new Error(error.message);
    if (!data) throw new Error('Empty response from backend');
    return data;
  }
  async update(id: string, patch: MemoryUpdateInput): Promise<Memory> {
    const { data, error } = await request<Memory>(`/memory/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: patch,
    });
    if (error) throw new Error(error.message);
    if (!data) throw new Error('Empty response from backend');
    return data;
  }
  async remove(id: string): Promise<void> {
    const { error } = await request<void>(`/memory/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (error) throw new Error(error.message);
  }
}

class BackendKnowledgeRepository implements KnowledgeRepository {
  private buildQuery(params: KnowledgeListParams = {}): string {
    const qs: string[] = [];
    if (params.projectId !== undefined) qs.push(`projectId=${encodeURIComponent(params.projectId ?? '')}`);
    if (params.category) qs.push(`category=${encodeURIComponent(params.category)}`);
    if (params.search) qs.push(`search=${encodeURIComponent(params.search)}`);
    if (params.activeOnly !== undefined) qs.push(`activeOnly=${String(params.activeOnly)}`);
    if (params.limit !== undefined) qs.push(`limit=${String(params.limit)}`);
    if (params.offset !== undefined) qs.push(`offset=${String(params.offset)}`);
    return qs.length ? `?${qs.join('&')}` : '';
  }
  async list(params: KnowledgeListParams = {}): Promise<ListResult<KnowledgeEntry>> {
    const { data, error } = await request<ListResult<KnowledgeEntry>>(`/knowledge${this.buildQuery(params)}`);
    if (error) throw new Error(error.message);
    return data ?? { items: [], total: 0 };
  }
  async get(id: string): Promise<KnowledgeEntry | null> {
    const { data, error } = await request<KnowledgeEntry>(`/knowledge/${encodeURIComponent(id)}`);
    if (error) throw new Error(error.message);
    return data;
  }
  async create(input: KnowledgeCreateInput): Promise<KnowledgeEntry> {
    const { data, error } = await request<KnowledgeEntry>('/knowledge', { method: 'POST', body: input });
    if (error) throw new Error(error.message);
    if (!data) throw new Error('Empty response from backend');
    return data;
  }
  async update(id: string, patch: KnowledgeUpdateInput): Promise<KnowledgeEntry> {
    const { data, error } = await request<KnowledgeEntry>(`/knowledge/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: patch,
    });
    if (error) throw new Error(error.message);
    if (!data) throw new Error('Empty response from backend');
    return data;
  }
  async remove(id: string): Promise<void> {
    const { error } = await request<void>(`/knowledge/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (error) throw new Error(error.message);
  }
}

export const backendRepositories: Repositories = {
  projects: new BackendProjectRepository(),
  conversations: new BackendConversationRepository(),
  messages: new BackendMessageRepository(),
  providers: new BackendProviderConfigRepository(),
  settings: new BackendSettingsRepository(),
  memories: new BackendMemoryRepository(),
  knowledge: new BackendKnowledgeRepository(),
};
