import { request } from '@/lib/http';
import type { ApiResult } from '@/types/domain';
import type {
  ApiConnection,
  ApiConnectionDetail,
  AgentDefaults,
  ConnectionTestResult,
  CreateConnectionInput,
  UpdateConnectionInput,
  ConnectionCredential,
  AddCredentialInput,
  UpdateCredentialInput,
  ConnectionModel,
  AddModelInput,
  UpdateModelInput,
  AdapterId,
} from '@/types/connections';

/**
 * Backend client for the AI connection management endpoints.
 *
 * All methods return an ApiResult envelope. Secrets are never returned by the
 * backend — only masked metadata. When no backend is configured, methods
 * return a `backend_unavailable` error so the UI can show a clear message.
 */

const ADAPTERS_PATH = '/connections/adapters';

export async function listAdapters(): Promise<ApiResult<AdapterId[]>> {
  const { data, error } = await request<{ adapters: AdapterId }>(ADAPTERS_PATH);
  if (error) return { data: null, error };
  return { data: (data?.adapters ?? []) as AdapterId[], error: null };
}

export async function listConnections(): Promise<ApiResult<ApiConnectionDetail[]>> {
  const { data, error } = await request<ApiConnectionDetail[]>('/connections');
  if (error) return { data: null, error };
  return { data: data ?? [], error: null };
}

export async function getConnection(id: string): Promise<ApiResult<ApiConnectionDetail>> {
  const { data, error } = await request<ApiConnectionDetail>(`/connections/${encodeURIComponent(id)}`);
  if (error) return { data: null, error };
  if (!data) return { data: null, error: { code: 'server', message: 'Empty response from backend.' } };
  return { data, error: null };
}

export async function createConnection(input: CreateConnectionInput): Promise<ApiResult<ApiConnection>> {
  const { data, error } = await request<ApiConnection>('/connections', { method: 'POST', body: input });
  if (error) return { data: null, error };
  if (!data) return { data: null, error: { code: 'server', message: 'Empty response from backend.' } };
  return { data, error: null };
}

export async function updateConnection(id: string, input: UpdateConnectionInput): Promise<ApiResult<ApiConnection>> {
  const { data, error } = await request<ApiConnection>(`/connections/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: input,
  });
  if (error) return { data: null, error };
  if (!data) return { data: null, error: { code: 'server', message: 'Empty response from backend.' } };
  return { data, error: null };
}

export async function deleteConnection(id: string): Promise<ApiResult<void>> {
  const { error } = await request<void>(`/connections/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (error) return { data: null, error };
  return { data: undefined, error: null };
}

// --- Credentials ---

export async function addCredential(connectionId: string, input: AddCredentialInput): Promise<ApiResult<ConnectionCredential>> {
  const { data, error } = await request<ConnectionCredential>(
    `/connections/${encodeURIComponent(connectionId)}/credentials`,
    { method: 'POST', body: input },
  );
  if (error) return { data: null, error };
  if (!data) return { data: null, error: { code: 'server', message: 'Empty response from backend.' } };
  return { data, error: null };
}

export async function updateCredential(connectionId: string, credId: string, input: UpdateCredentialInput): Promise<ApiResult<ConnectionCredential>> {
  const { data, error } = await request<ConnectionCredential>(
    `/connections/${encodeURIComponent(connectionId)}/credentials/${encodeURIComponent(credId)}`,
    { method: 'PATCH', body: input },
  );
  if (error) return { data: null, error };
  if (!data) return { data: null, error: { code: 'server', message: 'Empty response from backend.' } };
  return { data, error: null };
}

export async function deleteCredential(connectionId: string, credId: string): Promise<ApiResult<void>> {
  const { error } = await request<void>(
    `/connections/${encodeURIComponent(connectionId)}/credentials/${encodeURIComponent(credId)}`,
    { method: 'DELETE' },
  );
  if (error) return { data: null, error };
  return { data: undefined, error: null };
}

// --- Models ---

export async function addModel(connectionId: string, input: AddModelInput): Promise<ApiResult<ConnectionModel>> {
  const { data, error } = await request<ConnectionModel>(
    `/connections/${encodeURIComponent(connectionId)}/models`,
    { method: 'POST', body: input },
  );
  if (error) return { data: null, error };
  if (!data) return { data: null, error: { code: 'server', message: 'Empty response from backend.' } };
  return { data, error: null };
}

export async function updateModel(connectionId: string, modelId: string, input: UpdateModelInput): Promise<ApiResult<ConnectionModel>> {
  const { data, error } = await request<ConnectionModel>(
    `/connections/${encodeURIComponent(connectionId)}/models/${encodeURIComponent(modelId)}`,
    { method: 'PATCH', body: input },
  );
  if (error) return { data: null, error };
  if (!data) return { data: null, error: { code: 'server', message: 'Empty response from backend.' } };
  return { data, error: null };
}

export async function deleteModel(connectionId: string, modelId: string): Promise<ApiResult<void>> {
  const { error } = await request<void>(
    `/connections/${encodeURIComponent(connectionId)}/models/${encodeURIComponent(modelId)}`,
    { method: 'DELETE' },
  );
  if (error) return { data: null, error };
  return { data: undefined, error: null };
}

// --- Connection testing ---

export async function testConnection(connectionId: string, model: string, credentialId?: string): Promise<ApiResult<ConnectionTestResult>> {
  const { data, error } = await request<ConnectionTestResult>(
    `/connections/${encodeURIComponent(connectionId)}/test`,
    { method: 'POST', body: { model, credentialId } },
  );
  if (error) return { data: null, error };
  if (!data) return { data: null, error: { code: 'server', message: 'Empty response from backend.' } };
  return { data, error: null };
}

// --- Agent defaults ---

export async function getAgentDefaults(): Promise<ApiResult<AgentDefaults>> {
  const { data, error } = await request<AgentDefaults>('/connections/defaults');
  if (error) return { data: null, error };
  if (!data) return { data: null, error: { code: 'server', message: 'Empty response from backend.' } };
  return { data, error: null };
}

export async function setAgentDefaults(connectionId: string | null, model: string | null): Promise<ApiResult<AgentDefaults>> {
  const { data, error } = await request<AgentDefaults>('/connections/defaults', {
    method: 'PUT',
    body: { connectionId, model },
  });
  if (error) return { data: null, error };
  if (!data) return { data: null, error: { code: 'server', message: 'Empty response from backend.' } };
  return { data, error: null };
}
