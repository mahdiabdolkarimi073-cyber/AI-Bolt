import { request } from '@/lib/http';
import { logger } from '@/lib/logger';
import { config } from '@/config';
import type { ApiResult } from '@/types/domain';
import type { ProviderId } from '@/types';
import type { AgentResult, AgentConfig } from '@/types/agent';
import { apiErrorToAgentError as toAgentErr } from '@/types/agent';
import type { RetrievedContextItem, RetrievalMeta } from '@/types/memory';

export interface BackendAgentRunInput {
  conversationId: string;
  message: string;
  config: AgentConfig;
  signal?: AbortSignal;
  /** Frontend-generated request id for log correlation. */
  requestId?: string;
}

/** Shape returned by POST /agent/run. */
interface AgentRunPayload {
  requestId: string;
  conversationId: string;
  status: string;
  userMessage?: { id: string; conversationId: string; role: string; content: string; createdAt: number };
  assistantMessage?: { id: string; conversationId: string; role: string; content: string; createdAt: number };
  error?: { code: string; message: string };
  meta?: {
    providerId: string;
    connectionId?: string;
    model?: string;
    simulated?: boolean;
    finishReason?: string;
    usage?: unknown;
    requestId?: string;
    selectedModel?: string | null;
    modelSubstituted?: boolean;
    providerReportedModel?: string | null;
    providerResponseId?: string | null;
    providerActualModelConfirmed?: boolean;
  };
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
    requestId: input.requestId,
    logPrefix: 'CHAT',
    timeoutMs: config.agentRequestTimeoutMs,
  });
  if (error) {
    logger.error('CHAT', 'Backend agent run returned error', {
      requestId: input.requestId ?? '(none)',
      error_code: error.code,
    });
    return { data: null, error };
  }
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
          requestId: p.meta.requestId,
          selectedModel: p.meta.selectedModel,
          modelSubstituted: p.meta.modelSubstituted,
          providerReportedModel: p.meta.providerReportedModel,
          providerResponseId: p.meta.providerResponseId,
          providerActualModelConfirmed: p.meta.providerActualModelConfirmed,
        }
      : undefined,
    retrieval: p.retrieval ? (normalizeRetrieval(p.retrieval) as RetrievalMeta) : undefined,
    toolsExecuted: p.toolsExecuted,
    startedAt: p.startedAt,
    finishedAt: p.finishedAt,
  };
}

function normalizeRetrieval(r: { items: RetrievedContextItem[]; chars: number }): RetrievalMeta {
  return { items: r.items ?? [], chars: r.chars ?? 0 };
}

// --- SSE Streaming ---

export interface StreamCallbacks {
  onDelta: (text: string) => void;
  onActivity: (event: ActivityEvent) => void;
  onFileChange: (event: FileChangeEvent) => void;
  onToolStart: (event: { name: string; args: Record<string, unknown> }) => void;
  onToolResult: (event: { name: string; result: Record<string, unknown> }) => void;
  onDone: (result: AgentResult) => void;
  onError: (error: { code: string; message: string }) => void;
}

export interface ActivityEvent {
  status: string;
  message: string;
  fileName?: string;
}

export interface FileChangeEvent {
  path: string;
  action: 'created' | 'modified' | 'deleted' | 'renamed';
  oldPath?: string;
}

interface SSEDonePayload {
  assistantMessage?: { id: string; conversationId: string; role: string; content: string; createdAt: number };
  meta?: {
    providerId: string;
    connectionId?: string;
    model?: string;
    simulated?: boolean;
    finishReason?: string;
    usage?: unknown;
    requestId?: string;
    selectedModel?: string | null;
    modelSubstituted?: boolean;
  };
  toolsExecuted?: Array<{ name: string; args: Record<string, unknown>; result: Record<string, unknown> }>;
}

/**
 * Stream an agent run via SSE from POST /agent/run/stream.
 *
 * Uses fetch + ReadableStream to read SSE events. Properly handles SSE
 * message boundaries (events are separated by \n\n) regardless of how
 * network chunks are delivered.
 */
export async function streamAgentViaBackend(
  input: BackendAgentRunInput,
  callbacks: StreamCallbacks,
): Promise<void> {
  const url = `${config.apiBaseUrl}/agent/run/stream`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (input.requestId) headers['X-Request-Id'] = input.requestId;

  const body = JSON.stringify({
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
  });

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: input.signal,
    });
  } catch (err) {
    if (input.signal?.aborted) return;
    callbacks.onError({ code: 'network', message: 'Could not connect to the backend.' });
    return;
  }

  if (!res.ok || !res.body) {
    callbacks.onError({ code: 'server', message: `Backend returned HTTP ${res.status}.` });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by double newline.
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        parseSSEEvent(rawEvent, callbacks, input);
      }
    }
    // Flush any remaining buffered data.
    if (buffer.trim()) {
      parseSSEEvent(buffer, callbacks, input);
    }
  } catch (err) {
    if (input.signal?.aborted) return;
    logger.error('CHAT', 'SSE stream read error', { requestId: input.requestId ?? '(none)', msg: String(err).slice(0, 200) });
    callbacks.onError({ code: 'network', message: 'Connection interrupted during streaming.' });
  }
}

function parseSSEEvent(raw: string, callbacks: StreamCallbacks, input: BackendAgentRunInput): void {
  const lines = raw.split('\n');
  let event = '';
  let dataStr = '';
  for (const line of lines) {
    if (line.startsWith('event: ')) event = line.slice(7).trim();
    else if (line.startsWith('data: ')) dataStr = line.slice(6);
  }
  if (!event || !dataStr) return;

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(dataStr);
  } catch {
    return;
  }

  switch (event) {
    case 'delta':
      callbacks.onDelta(data.text as string);
      break;
    case 'activity':
      callbacks.onActivity({ status: data.status as string, message: data.message as string, fileName: data.fileName as string | undefined });
      break;
    case 'file_change':
      callbacks.onFileChange({ path: data.path as string, action: data.action as FileChangeEvent['action'], oldPath: data.oldPath as string | undefined });
      break;
    case 'tool_start':
      callbacks.onToolStart({ name: data.name as string, args: data.args as Record<string, unknown> });
      break;
    case 'tool_result':
      callbacks.onToolResult({ name: data.name as string, result: data.result as Record<string, unknown> });
      break;
    case 'done': {
      const payload = data as unknown as SSEDonePayload;
      const result = donePayloadToAgentResult(payload, input);
      callbacks.onDone(result);
      break;
    }
    case 'error':
      callbacks.onError({ code: (data.code as string) ?? 'unknown', message: (data.message as string) ?? 'Unknown error.' });
      break;
  }
}

function donePayloadToAgentResult(payload: SSEDonePayload, input: BackendAgentRunInput): AgentResult {
  return {
    requestId: input.requestId ?? '',
    conversationId: input.conversationId,
    status: 'completed',
    assistantMessage: payload.assistantMessage
      ? {
          id: payload.assistantMessage.id,
          role: 'assistant',
          content: payload.assistantMessage.content,
          createdAt: payload.assistantMessage.createdAt,
          simulated: payload.meta?.simulated,
        }
      : undefined,
    meta: payload.meta
      ? {
          providerId: payload.meta.providerId as ProviderId | 'dev',
          connectionId: payload.meta.connectionId,
          model: payload.meta.model,
          simulated: payload.meta.simulated,
          finishReason: payload.meta.finishReason,
          requestId: payload.meta.requestId,
          selectedModel: payload.meta.selectedModel,
          modelSubstituted: payload.meta.modelSubstituted,
        }
      : undefined,
    toolsExecuted: payload.toolsExecuted,
    startedAt: Date.now(),
    finishedAt: Date.now(),
  };
}
