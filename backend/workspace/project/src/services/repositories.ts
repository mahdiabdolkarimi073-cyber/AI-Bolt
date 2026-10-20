import type { Project, Conversation, ConversationMessage, ProviderConfig, AppSettings } from '@/types/domain';
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
 * Persistence contracts. The UI layer programs against these interfaces,
 * never against a specific implementation. This lets the app run:
 *   - in the browser with a local fallback (InMemoryRepositories), or
 *   - against the FastAPI backend (BackendRepositories) when configured.
 *
 * Secrets (provider API keys) are intentionally NOT exposed here — the frontend
 * only learns whether a key is set (`hasApiKey`), never the key itself.
 */

export interface ProjectRepository {
  list(): Promise<Project[]>;
  get(id: string): Promise<Project | null>;
  create(input: {
    name: string;
    path: string;
    template: string;
    workspacePath?: string;
    importSource?: string;
  }): Promise<Project>;
  update(id: string, patch: Partial<Pick<Project, 'name' | 'path' | 'workspacePath'>>): Promise<Project>;
  remove(id: string): Promise<void>;
}

export interface ConversationRepository {
  list(projectId?: string | null): Promise<Conversation[]>;
  get(id: string): Promise<Conversation | null>;
  create(input: { projectId: string | null; title: string }): Promise<Conversation>;
  rename(id: string, title: string): Promise<Conversation>;
  remove(id: string): Promise<void>;
}

export interface MessageRepository {
  list(conversationId: string): Promise<ConversationMessage[]>;
  append(input: {
    conversationId: string;
    role: ConversationMessage['role'];
    content: string;
    steps?: ConversationMessage['steps'];
  }): Promise<ConversationMessage>;
  remove(id: string): Promise<void>;
  clear(conversationId: string): Promise<void>;
}

export interface ProviderConfigRepository {
  list(): Promise<ProviderConfig[]>;
  get(id: string): Promise<ProviderConfig | null>;
  upsert(input: {
    id: string;
    enabled: boolean;
    model: string;
    baseUrl?: string;
  }): Promise<ProviderConfig>;
  /** Set (or clear) the API key on the backend. The key itself is never returned. */
  setApiKey(id: string, key: string | null): Promise<ProviderConfig>;
}

export interface SettingsRepository {
  get(): Promise<AppSettings>;
  update(patch: Partial<AppSettings>): Promise<AppSettings>;
}

export interface MemoryRepository {
  list(params?: MemoryListParams): Promise<ListResult<Memory>>;
  get(id: string): Promise<Memory | null>;
  create(input: MemoryCreateInput): Promise<Memory>;
  update(id: string, patch: MemoryUpdateInput): Promise<Memory>;
  remove(id: string): Promise<void>;
}

export interface KnowledgeRepository {
  list(params?: KnowledgeListParams): Promise<ListResult<KnowledgeEntry>>;
  get(id: string): Promise<KnowledgeEntry | null>;
  create(input: KnowledgeCreateInput): Promise<KnowledgeEntry>;
  update(id: string, patch: KnowledgeUpdateInput): Promise<KnowledgeEntry>;
  remove(id: string): Promise<void>;
}

export interface Repositories {
  projects: ProjectRepository;
  conversations: ConversationRepository;
  messages: MessageRepository;
  providers: ProviderConfigRepository;
  settings: SettingsRepository;
  memories: MemoryRepository;
  knowledge: KnowledgeRepository;
}
