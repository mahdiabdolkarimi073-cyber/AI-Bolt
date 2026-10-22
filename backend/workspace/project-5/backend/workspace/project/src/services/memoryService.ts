import { getRepositories } from '@/services/index';
import type { Memory, KnowledgeEntry, MemoryCreateInput, MemoryUpdateInput, KnowledgeCreateInput, KnowledgeUpdateInput, MemoryListParams, KnowledgeListParams, ListResult } from '@/types/memory';
import type { ApiResult, ApiError } from '@/types/domain';

/**
 * Frontend service for the persistent memory + knowledge base.
 *
 * Delegates to the active repository set (in-memory fallback or backend),
 * so the same code path works in both modes. Methods return an ApiResult
 * envelope like the connection service does, so callers can render consistent
 * loading / success / error states.
 */

function toError(err: unknown): ApiError {
  const message = err instanceof Error ? err.message : 'Operation failed.';
  return { code: 'server', message };
}

export async function listMemories(params: MemoryListParams = {}): Promise<ApiResult<ListResult<Memory>>> {
  try {
    const repos = getRepositories();
    const data = await repos.memories.list(params);
    return { data, error: null };
  } catch (err) {
    return { data: null, error: toError(err) };
  }
}

export async function getMemory(id: string): Promise<ApiResult<Memory>> {
  try {
    const repos = getRepositories();
    const data = await repos.memories.get(id);
    if (!data) return { data: null, error: { code: 'not_found', message: 'Memory not found.' } };
    return { data, error: null };
  } catch (err) {
    return { data: null, error: toError(err) };
  }
}

export async function createMemory(input: MemoryCreateInput): Promise<ApiResult<Memory>> {
  try {
    const repos = getRepositories();
    const data = await repos.memories.create(input);
    return { data, error: null };
  } catch (err) {
    return { data: null, error: toError(err) };
  }
}

export async function updateMemory(id: string, patch: MemoryUpdateInput): Promise<ApiResult<Memory>> {
  try {
    const repos = getRepositories();
    const data = await repos.memories.update(id, patch);
    return { data, error: null };
  } catch (err) {
    return { data: null, error: toError(err) };
  }
}

export async function deleteMemory(id: string): Promise<ApiResult<void>> {
  try {
    const repos = getRepositories();
    await repos.memories.remove(id);
    return { data: undefined, error: null };
  } catch (err) {
    return { data: null, error: toError(err) };
  }
}

export async function listKnowledge(params: KnowledgeListParams = {}): Promise<ApiResult<ListResult<KnowledgeEntry>>> {
  try {
    const repos = getRepositories();
    const data = await repos.knowledge.list(params);
    return { data, error: null };
  } catch (err) {
    return { data: null, error: toError(err) };
  }
}

export async function getKnowledge(id: string): Promise<ApiResult<KnowledgeEntry>> {
  try {
    const repos = getRepositories();
    const data = await repos.knowledge.get(id);
    if (!data) return { data: null, error: { code: 'not_found', message: 'Knowledge entry not found.' } };
    return { data, error: null };
  } catch (err) {
    return { data: null, error: toError(err) };
  }
}

export async function createKnowledge(input: KnowledgeCreateInput): Promise<ApiResult<KnowledgeEntry>> {
  try {
    const repos = getRepositories();
    const data = await repos.knowledge.create(input);
    return { data, error: null };
  } catch (err) {
    return { data: null, error: toError(err) };
  }
}

export async function updateKnowledge(id: string, patch: KnowledgeUpdateInput): Promise<ApiResult<KnowledgeEntry>> {
  try {
    const repos = getRepositories();
    const data = await repos.knowledge.update(id, patch);
    return { data, error: null };
  } catch (err) {
    return { data: null, error: toError(err) };
  }
}

export async function deleteKnowledge(id: string): Promise<ApiResult<void>> {
  try {
    const repos = getRepositories();
    await repos.knowledge.remove(id);
    return { data: undefined, error: null };
  } catch (err) {
    return { data: null, error: toError(err) };
  }
}
