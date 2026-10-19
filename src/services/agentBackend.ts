import { request } from '@/lib/http';
import type { ApiResult } from '@/types/domain';
import type { ProviderId } from '@/types';
import type { AgentResult, AgentConfig } from '@/types/agent';
import { apiErrorToAgentError as toAgentErr } from '@/types/agent';
import type { RetrievedContextItem, RetrievalMeta } from '@/types/memory';

/**
 * Backend client for the Agent execution endpoint.
 *
 * Only used when a backend is configured. In browser fallback mode the
 * frontend AgentRuntime handles execution directly (with the DevProvider for
 * simulation, since no real provider keys exist in the browser).
 */

export interface BackendAgentRunInput {
  conversationId: string;
  message: string;
  config: AgentConfig;
  signal?: AbortSignal;
}

/** Shape returned by POST /agent/run. */
interface AgentRunPayload {
  requestId: string;
  conversationId: string;
  status: string;
  userMessage?: { id: string; conversationId: string; role: string; content: string; createdAt: number };
  assistantMessage?: { id: string; conversationId: string; role: string; content: string; createdAt: number };
  error?: { code: string; message: string };
  meta?: { providerId: string; connectionId?: string; model?: string; simulated?: boolean; finishReason?: string; usage?: unknown };
  retrieval?: { items: RetrievedContextItem[]; chars: number };
  startedAt: number;
  finishedAt: number;
}

export async function runAgentViaBackend(input: BackendAgentRunInput): Promise<ApiResult<AgentResult>> {
  const { data, error } = await request<AgentRunPayload>('/agent/run', {
    method: 'POST',
    body: {
      conversationId: input.conversationId,
      message: input.message,
      model: input.config.model,
      providerId: input.config.providerId,
      connectionId: input.config.connectionId,
      systemPrompt: input.config.systemPrompt,
      allowSimulation: input.config.allowSimulation === true,
      maxContextChars: input.config.maxContextChars ?? 24000,
      maxHistoryMessages: input.config.maxHistoryMessages ?? 20,
      projectId: input.config.projectId ?? null,
      maxRetrievalChars: input.config.maxRetrievalChars ?? 3500,
    },
    signal: input.signal,
  });
  if (error) return { data: null, error };
  if (!data) return { data: null, error: { code: 'server', message: 'Empty response from backend.' } };
  return { data: toAgentResult(data), error: null };
}

function toAgentResult(p: AgentRunPayload): AgentResult {
  return {
    requestId: p.requestId,
    conversationId: p.conversationId,
    status: p.status as AgentResult['status'],
    userMessage: p.userMessage
      ? { id: p.userMessage.id, role: 'user', content: p.userMessage.content, createdAt: p.userMessage.createdAt }
      : undefined,
    assistantMessage: p.assistantMessage
      ? {
          id: p.assistantMessage.id,
          role: 'assistant',
          content: p.assistantMessage.content,
          createdAt: p.assistantMessage.createdAt,
          simulated: p.meta?.simulated,
        }
      : undefined,
    error: p.error ? toAgentErr(p.error) : undefined,
    meta: p.meta
      ? {
          providerId: p.meta.providerId as ProviderId | 'dev',
          connectionId: p.meta.connectionId,
          model: p.meta.model,
          simulated: p.meta.simulated,
          finishReason: p.meta.finishReason,
        }
      : undefined,
    retrieval: p.retrieval ? (normalizeRetrieval(p.retrieval) as RetrievalMeta) : undefined,
    startedAt: p.startedAt,
    finishedAt: p.finishedAt,
  };
}

function normalizeRetrieval(r: { items: RetrievedContextItem[]; chars: number }): RetrievalMeta {
  return { items: r.items ?? [], chars: r.chars ?? 0 };
}
