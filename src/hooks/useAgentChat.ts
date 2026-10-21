import { useCallback, useRef, useState } from 'react';
import { config } from '@/config';
import type { ProviderId } from '@/types';
import type { AgentResult, AgentMessage } from '@/types/agent';
import { getAgentRuntime } from '@/services/agentService';
import { getRepositories } from '@/services/index';
import { runAgentViaBackend, streamAgentViaBackend, type ActivityEvent, type FileChangeEvent } from '@/services/agentBackend';
import { apiErrorToAgentError } from '@/types/agent';
import type { ProviderExecutionMeta } from '@/types/agent';
import { logger } from '@/lib/logger';

export interface UseAgentChatOptions {
  conversationId: string | null;
  providerId: ProviderId;
  model: string;
  connectionId?: string | null;
  allowSimulation?: boolean;
  projectId?: string | null;
  /** Callback fired when the agent creates/modifies/deletes a file, so the
   *  UI can refresh the file tree and optionally open the file. */
  onFileChange?: (event: FileChangeEvent) => void;
  onProjectCreated?: (event: { projectId: string; workspacePath: string; files: string[] }) => void;
}

export interface AgentChatState {
  messages: AgentMessage[];
  busy: boolean;
  lastError: string | null;
  lastSimulated: boolean;
  /** Text that is currently being streamed in (progressive display). */
  streamingText: string;
  /** Whether a stream is actively producing text. */
  isStreaming: boolean;
  /** Activity events from the current/last run. */
  activity: ActivityEvent[];
  /** Tool executions from the current/last run. */
  toolEvents: Array<{ name: string; args: Record<string, unknown>; result?: Record<string, unknown> }>;
}

export interface UseAgentChatReturn extends AgentChatState {
  send: (text: string, conversationIdOverride?: string) => Promise<AgentResult | null>;
  stop: () => void;
  refresh: (conversationIdOverride?: string) => Promise<void>;
  clearError: () => void;
  lastMeta?: ProviderExecutionMeta;
}

export function useAgentChat(opts: UseAgentChatOptions): UseAgentChatReturn {
  const { conversationId, providerId, model, connectionId = null, allowSimulation, projectId = null, onFileChange, onProjectCreated } = opts;
  const simulationAllowed = allowSimulation ?? !config.backendEnabled;
  const [state, setState] = useState<AgentChatState>({
    messages: [],
    busy: false,
    lastError: null,
    lastSimulated: false,
    streamingText: '',
    isStreaming: false,
    activity: [],
    toolEvents: [],
  });
  const [lastMeta, setLastMeta] = useState<ProviderExecutionMeta | undefined>(undefined);
  const controllerRef = useRef<AbortController | null>(null);
  const reqCounter = useRef(0);
  const onFileChangeRef = useRef(onFileChange);
  onFileChangeRef.current = onFileChange;
  const onProjectCreatedRef = useRef(onProjectCreated);
  onProjectCreatedRef.current = onProjectCreated;

  const refresh = useCallback(async (override?: string) => {
    const cid = override ?? conversationId;
    if (!cid) {
      setState((s) => ({ ...s, messages: [] }));
      return;
    }
    try {
      const repos = getRepositories();
      const list = await repos.messages.list(cid);
      setState((s) => ({
        ...s,
        messages: list.map((m) => ({
          id: m.id,
          role: m.role as AgentMessage['role'],
          content: m.content,
          createdAt: m.createdAt,
        })),
      }));
    } catch {
      // Keep existing messages on load failure.
    }
  }, [conversationId]);

  const send = useCallback(
    async (text: string, conversationIdOverride?: string): Promise<AgentResult | null> => {
      const cid = conversationIdOverride ?? conversationId;
      if (!cid) return null;
      const trimmed = text.trim();
      if (!trimmed) return null;
      if (controllerRef.current) return null;

      const controller = new AbortController();
      controllerRef.current = controller;
      reqCounter.current += 1;
      const requestId = `req-${Date.now().toString(36)}-${reqCounter.current}`;
      const startTime = performance.now();

      logger.info('CHAT', 'User message submitted', {
        requestId,
        conversationId: cid,
        provider: providerId,
        selectedModel: model || '(empty)',
        connectionId: connectionId ?? '(default)',
        messageLen: trimmed.length,
      });

      setState((s) => ({
        ...s,
        busy: true,
        lastError: null,
        streamingText: '',
        isStreaming: false,
        activity: [],
        toolEvents: [],
      }));

      try {
        let result: AgentResult;

        if (config.backendEnabled) {
          // Streaming mode: use SSE endpoint for progressive display.
          const streamInput = {
            conversationId: cid,
            message: trimmed,
            config: { providerId, model, connectionId: connectionId ?? undefined, allowSimulation: simulationAllowed, projectId },
            signal: controller.signal,
            requestId,
          };

          let streamResult: AgentResult | null = null;
          let streamError: { code: string; message: string } | null = null;

          await streamAgentViaBackend(streamInput, {
            onDelta: (deltaText) => {
              setState((s) => ({ ...s, streamingText: s.streamingText + deltaText, isStreaming: true }));
            },
            onActivity: (event) => {
              setState((s) => ({ ...s, activity: [...s.activity, event] }));
            },
            onFileChange: (event) => {
              onFileChangeRef.current?.(event);
            },
            onToolStart: (event) => {
              setState((s) => ({ ...s, toolEvents: [...s.toolEvents, { name: event.name, args: event.args }] }));
            },
            onToolResult: (event) => {
              setState((s) => ({
                ...s,
                toolEvents: s.toolEvents.map((t, i) =>
                  i === s.toolEvents.length - 1 && t.name === event.name && !t.result
                    ? { ...t, result: event.result }
                    : t,
                ),
              }));
            },
            onProjectCreated: (event) => {
              onProjectCreatedRef.current?.(event);
            },
            onDone: (res) => {
              streamResult = res;
            },
            onError: (err) => {
              streamError = err;
            },
          });

          const durationMs = Math.round(performance.now() - startTime);

          if (streamError && !streamResult) {
            result = {
              requestId,
              conversationId: cid,
              status: 'failed',
              error: apiErrorToAgentError(streamError),
              startedAt: Date.now(),
              finishedAt: Date.now(),
            };
            logger.error('ERROR', 'Backend stream failed', {
              requestId,
              error_code: streamError.code,
              durationMs,
            });
          } else if (streamResult) {
            result = streamResult;
            logger.info('CHAT', 'Stream completed', {
              requestId,
              status: result.status,
              durationMs,
              resolvedModel: result.meta?.model ?? '(none)',
              simulated: result.meta?.simulated ?? false,
            });
          } else {
            // Stream was aborted (user clicked Stop) — no result, no error.
            result = {
              requestId,
              conversationId: cid,
              status: 'cancelled',
              startedAt: Date.now(),
              finishedAt: Date.now(),
            };
          }
        } else {
          const runtime = getAgentRuntime();
          result = await runtime.run({
            conversationId: cid,
            message: trimmed,
            requestId,
            config: { providerId, model, connectionId: connectionId ?? undefined, allowSimulation: simulationAllowed, projectId },
            signal: controller.signal,
          });
          const durationMs = Math.round(performance.now() - startTime);
          if (result.status === 'completed') {
            logger.info('CHAT', 'Local runtime completed', {
              requestId,
              status: result.status,
              durationMs,
              resolvedModel: result.meta?.model ?? '(none)',
              simulated: result.meta?.simulated ?? false,
            });
          } else if (result.status === 'failed') {
            logger.error('ERROR', 'Local runtime failed', {
              requestId,
              error_code: result.error?.code ?? 'unknown',
              durationMs,
            });
          }
        }

        // Refresh persisted messages from the authoritative store.
        await refresh(cid);

        const errorMsg = result.error?.message ?? null;
        const simulated = result.meta?.simulated === true || result.assistantMessage?.simulated === true;
        setLastMeta(result.meta);
        setState((s) => ({
          ...s,
          busy: false,
          lastError: errorMsg,
          lastSimulated: simulated,
          streamingText: '',
          isStreaming: false,
        }));
        return result;
      } catch (err) {
        const durationMs = Math.round(performance.now() - startTime);
        const msg = err instanceof Error ? err.message : 'Unexpected error.';
        logger.error('ERROR', 'Unexpected exception during chat', {
          requestId,
          durationMs,
          msg: msg.slice(0, 200),
        });
        setState((s) => ({ ...s, busy: false, lastError: msg, streamingText: '', isStreaming: false }));
        return null;
      } finally {
        controllerRef.current = null;
      }
    },
    [conversationId, providerId, model, connectionId, simulationAllowed, projectId, refresh],
  );

  const stop = useCallback(() => {
    if (controllerRef.current) {
      controllerRef.current.abort();
      logger.warn('CHAT', 'Request cancelled by user', {});
    }
    if (!config.backendEnabled && conversationId) {
      getAgentRuntime().cancel(conversationId);
    }
    setState((s) => ({ ...s, busy: false, isStreaming: false, streamingText: '' }));
  }, [conversationId]);

  const clearError = useCallback(() => {
    setState((s) => ({ ...s, lastError: null }));
  }, []);

  return { ...state, send, stop, refresh, clearError, lastMeta };
}
