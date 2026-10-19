// Domain-level types for the Personal AI IDE.
// UI-only types (SidebarSection, BottomTab) remain in src/types.ts.

import type { ProviderId } from '@/types';

/** Persisted project record. */
export interface Project {
  id: string;
  name: string;
  path: string;
  template: string;
  createdAt: number;
  updatedAt: number;
}

/** Persisted chat conversation. */
export interface Conversation {
  id: string;
  projectId: string | null;
  title: string;
  createdAt: number;
  updatedAt: number;
}

/** Persisted chat message belonging to a conversation. */
export interface ConversationMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  steps?: ChatStepRecord[];
  createdAt: number;
}

export interface ChatStepRecord {
  id: string;
  label: string;
  status: 'running' | 'done' | 'pending' | 'failed';
}

/** Persisted provider config. API keys are stored locally only (backend), never in the browser. */
export interface ProviderConfig {
  id: ProviderId;
  enabled: boolean;
  model: string;
  hasApiKey: boolean;
  baseUrl?: string;
}

/** App-wide settings (non-secret). */
export interface AppSettings {
  activeProvider: ProviderId;
  activeProjectId: string | null;
  theme: 'dark' | 'light';
  fontSize: number;
  tabSize: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  activeProvider: 'gemini',
  activeProjectId: null,
  theme: 'dark',
  fontSize: 13,
  tabSize: 2,
};

/** A normalized API error returned by the backend or thrown by the client. */
export interface ApiError {
  code: string;
  message: string;
  status?: number;
  details?: unknown;
}

/** Standard envelope for backend responses. */
export interface ApiResult<T> {
  data: T | null;
  error: ApiError | null;
}

export type AsyncResult<T> =
  | { kind: 'loading' }
  | { kind: 'success'; data: T }
  | { kind: 'error'; error: ApiError };
