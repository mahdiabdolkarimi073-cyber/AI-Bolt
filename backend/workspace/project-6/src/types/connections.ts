// Connection management types (Phase 6).
//
// These describe the API connection system: a user-defined connection binds an
// adapter (protocol) to a base URL, a set of credentials, and a set of models.
// Secrets are NEVER present in these types — only masked metadata.

/** Adapter protocol identifiers supported by the backend. */
export type AdapterId = 'openai_compatible' | 'gemini';

/** A user-configured API connection. */
export interface ApiConnection {
  id: string;
  displayName: string;
  adapter: AdapterId;
  providerLabel?: string | null;
  baseUrl?: string | null;
  enabled: boolean;
  /** Last-tested status: 'untested' | 'connected' | 'error'. */
  status: string;
  defaultModel?: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A model configured for a connection. */
export interface ConnectionModel {
  id: string;
  connectionId: string;
  modelId: string;
  label?: string | null;
  enabled: boolean;
  isDefault: boolean;
  createdAt: number;
}

/** Masked credential metadata. The full key is never present. */
export interface ConnectionCredential {
  id: string;
  connectionId: string;
  label?: string | null;
  /** Masked representation, e.g. "sk-x••••••••ab12". */
  keyMask: string;
  enabled: boolean;
  isPrimary: boolean;
  createdAt: number;
  updatedAt: number;
}

/** A connection with nested models + credentials, as returned by list/detail. */
export interface ApiConnectionDetail extends ApiConnection {
  models: ConnectionModel[];
  credentials: ConnectionCredential[];
  hasKey: boolean;
}

/** Default connection + model for new Agent conversations. */
export interface AgentDefaults {
  connectionId: string | null;
  model: string | null;
}

/** Categories returned by the connection test endpoint. */
export type TestCategory =
  | 'ok'
  | 'auth_failed'
  | 'rate_limited'
  | 'quota_or_billing'
  | 'invalid_model'
  | 'invalid_endpoint'
  | 'timeout'
  | 'network_error'
  | 'provider_error'
  | 'not_configured';

export interface ConnectionTestResult {
  category: TestCategory;
  message: string;
  statusCode?: number | null;
}

/** Input for creating a connection. */
export interface CreateConnectionInput {
  displayName: string;
  adapter: AdapterId;
  providerLabel?: string;
  baseUrl?: string;
  enabled?: boolean;
}

/** Input for updating a connection. All fields optional. */
export interface UpdateConnectionInput {
  displayName?: string;
  providerLabel?: string | null;
  baseUrl?: string | null;
  enabled?: boolean;
  status?: string;
  defaultModel?: string | null;
}

export interface AddCredentialInput {
  secret: string;
  label?: string;
  isPrimary?: boolean;
}

export interface UpdateCredentialInput {
  label?: string | null;
  enabled?: boolean;
  isPrimary?: boolean;
}

export interface AddModelInput {
  modelId: string;
  label?: string;
  isDefault?: boolean;
}

export interface UpdateModelInput {
  label?: string | null;
  enabled?: boolean;
  isDefault?: boolean;
}

/** Human-readable labels for adapters, used in the UI. */
export const ADAPTER_LABELS: Record<AdapterId, string> = {
  openai_compatible: 'OpenAI-compatible',
  gemini: 'Google Gemini',
};

/** Human-readable labels for test categories. */
export const TEST_CATEGORY_LABELS: Record<string, string> = {
  ok: 'Connection successful',
  auth_failed: 'Authentication failed',
  rate_limited: 'Rate limited',
  quota_or_billing: 'Quota or billing issue',
  invalid_model: 'Invalid model',
  invalid_endpoint: 'Invalid endpoint',
  timeout: 'Timeout',
  network_error: 'Network error',
  provider_error: 'Provider error',
  not_configured: 'Not configured',
};

/** Suggested default base URLs for known compatible services. */
export const ADAPTER_DEFAULT_URLS: Record<AdapterId, string> = {
  openai_compatible: 'https://api.groq.com/openai',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
};

/** Provider preset for the create-connection form. */
export interface ProviderPreset {
  id: string;
  label: string;
  adapter: AdapterId;
  baseUrl: string;
  defaultModel: string;
}

/** Diagnostic event from the backend. */
export interface DiagnosticEvent {
  id: string;
  eventType: string;
  connectionId?: string | null;
  providerId?: string | null;
  model?: string | null;
  status?: string | null;
  durationMs?: number | null;
  message: string;
  details: Record<string, unknown>;
  createdAt: number;
}
