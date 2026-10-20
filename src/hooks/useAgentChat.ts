import { useCallback, useRef, useState } from 'react';
import { config } from '@/config';
import type { ProviderId } from '@/types';
import type { AgentResult, AgentMessage } from '@/types/agent';
import { getAgentRuntime } from '@/services/agentService';
import { getRepositories } from '@/services/index';
import { runAgentViaBackend } from '@/services/agentBackend';
import { apiErrorToAgentError } from '@/types/agent';
import type { ProviderExecutionMeta } from '@/types/agent';
import { logger } from '@/lib/logger';

/**
 * React hook that bridges the Agent runtime to the chat UI.
 *
 * - In backend mode, delegates to POST /agent/run (single authoritative
 *   persistence path on the server).
 * - In fallback mode, runs the local AgentRuntime (DevProvider simulation,
 *   since no real provider keys exist in the browser).
 *
 * The hook is the ONLY place that submits messages and refreshes the message
 * list, preventing the UI from independently persisting duplicates.
 */

export interface UseAgentChatOptions {
  conversationId: string | null;
  providerId: ProviderId;
  model: string;
  /** Phase 6: configured connection id. When set, the backend routes through
   *  that connection's adapter + credentials. When null in backend mode, the
   *  backend uses its configured agent default. */
  connectionId?: string | null;
  /** Allow the deterministic dev provider to answer when no real provider is ready.
   *  Defaults to false in backend mode (never silently simulate) and true in
   *  browser fallback mode (so the UI is still exercisable without a backend). */
  allowSimulation?: boolean;
  /** Phase 7: active project id for memory/knowledge retrieval scoping. */
  projectId?: string | null;
}

export interface AgentChatState {
  messages: AgentMessage[];
  busy: boolean;
  lastError: string | null;
  lastSimulated: boolean;
}

export interface UseAgentChatReturn extends AgentChatState {
  /** Send a message. An optional override lets the caller supply a freshly
   *  created conversation id before the hook has re-rendered with it. */
  send: (text: string, conversationIdOverride?: string) => Promise<AgentResult | null>;
  stop: () => void;
  refresh: (conversationIdOverride?: string) => Promise<void>;
  clearError: () => void;
  /** Metadata from the most recent completed provider request, for diagnostics. */
  lastMeta?: import('@/types/agent').ProviderExecutionMeta;
}

export function useAgentChat(opts: UseAgentChatOptions): UseAgentChatReturn {
  const { conversationId, providerId, model, connectionId = null, allowSimulation, projectId = null } = opts;
  // In backend mode, default simulation OFF — never silently return a simulated
  // response when a real connection is expected. In fallback mode, allow it so
  // the UI remains demonstrable without a backend.
  const simulationAllowed = allowSimulation ?? !config.backendEnabled;
  const [state, setState] = useState<AgentChatState>({
    messages: [],
    busy: false,
    lastError: null,
    lastSimulated: false,
  });
  const [lastMeta, setLastMeta] = useState<ProviderExecutionMeta | undefined>(undefined);
  const controllerRef = useRef<AbortController | null>(null);
  const reqCounter = useRef(0);

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
      if (controllerRef.current) return null; // prevent overlapping submissions

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

      setState((s) => ({ ...s, busy: true, lastError: null }));

      try {
        let result: AgentResult;
        if (config.backendEnabled) {
          logger.debug('CHAT', 'Sending request to backend', {
            requestId,
            endpoint: '/agent/run',
            provider: providerId,
            selectedModel: model || '(empty)',
          });
          const { data, error } = await runAgentViaBackend({
            conversationId: cid,
            message: trimmed,
            config: { providerId, model, connectionId: connectionId ?? undefined, allowSimulation: simulationAllowed, projectId },
            signal: controller.signal,
            requestId,
          });
          const durationMs = Math.round(performance.now() - startTime);
          if (error || !data) {
            result = {
              requestId,
              conversationId: cid,
              status: 'failed',
              error: error
                ? apiErrorToAgentError(error)
                : { code: 'unknown', message: 'Backend agent run failed.' },
              startedAt: Date.now(),
              finishedAt: Date.now(),
            };
            logger.error('ERROR', 'Backend agent run failed', {
              requestId,
              error_code: result.error?.code ?? 'unknown',
              durationMs,
            });
          } else {
            result = data;
            logger.info('CHAT', 'Backend response received', {
              requestId,
              status: result.status,
              durationMs,
              resolvedModel: result.meta?.model ?? '(none)',
              providerReportedModel: result.meta?.providerReportedModel ?? '(unreported)',
              modelSubstituted: result.meta?.modelSubstituted ?? false,
              simulated: result.meta?.simulated ?? false,
            });
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
        setState((s) => ({ ...s, busy: false, lastError: msg }));
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
    setState((s) => ({ ...s, busy: false }));
  }, [conversationId]);

  const clearError = useCallback(() => {
    setState((s) => ({ ...s, lastError: null }));
  }, []);

  return { ...state, send, stop, refresh, clearError, lastMeta };
}
