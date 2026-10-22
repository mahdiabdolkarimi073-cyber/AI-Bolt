import type { ProviderId } from '@/types';
import type {
  AgentRequest,
  AgentResult,
  AgentMessage,
  AgentError,
  RunStatus,
  ProviderExecutionMeta,
  ToolCall,
} from '@/types/agent';
import type { RetrievalMeta, RetrievedContextItem } from '@/types/memory';
import type { AIProvider, ProviderExecuteRequest } from '@/services/providers/aiProvider';
import { ProviderError } from '@/services/providers/aiProvider';
import type { Repositories } from './repositories';
import { buildContext, type BuiltContext } from './contextBuilder';
import { unsupportedToolResult } from './tools';
import { retrieveContext, renderContextBlock, DEFAULT_RETRIEVAL_BUDGET_CHARS } from './retrieval';

/**
 * Agent runtime — the orchestration core.
 *
 * Responsibilities:
 *   - Accept a validated AgentRequest.
 *   - Resolve the selected provider through the existing provider abstraction.
 *   - Validate the requested model/config against declared capabilities.
 *   - Load conversation history through the existing persistence layer.
 *   - Build context in the correct order (via contextBuilder).
 *   - Send the request through the provider interface.
 *   - Process the provider response + metadata.
 *   - Persist user + assistant messages through ONE authoritative path.
 *   - Return a structured AgentResult.
 *   - Handle failures without corrupting conversation history.
 *   - Support cancellation when the provider/execution path allow it.
 *   - Prevent overlapping/duplicate submissions per conversation.
 *
 * Persistence ownership:
 *   The runtime is the SINGLE authoritative persistence path for agent runs.
 *   The UI does NOT independently save the user/assistant messages — it reads
 *   them back from the repository after the run. This prevents double-save.
 *
 * Lifecycle:
 *   pending -> running -> provider_in_progress -> completed | failed | cancelled
 */

export interface AgentRuntimeOptions {
  repositories: Repositories;
  /** Resolve a provider adapter by id. */
  resolveProvider: (id: ProviderId) => AIProvider | null;
  /** Optional: a dev/simulated provider used when allowSimulation is true. */
  devProvider?: AIProvider;
  /** Default system prompt when the request doesn't supply one. */
  defaultSystemPrompt?: string;
  /** Default context limits. */
  defaultMaxContextChars?: number;
  defaultMaxHistoryMessages?: number;
  defaultTimeoutMs?: number;
  /** Default character budget for retrieved memory/knowledge context. */
  defaultMaxRetrievalChars?: number;
}

interface RunState {
  status: RunStatus;
  controller: AbortController;
  startedAt: number;
}

export class AgentRuntime {
  private opts: AgentRuntimeOptions;
  /** Active runs keyed by conversationId to prevent overlap. */
  private active = new Map<string, RunState>();
  /** Recently seen requestIds to reject duplicate submissions. */
  private recentRequestIds = new Set<string>();

  constructor(opts: AgentRuntimeOptions) {
    this.opts = opts;
  }

  /**
   * Execute an agent run. Returns a structured result. Never throws —
   * failures are captured in `result.error`.
   */
  async run(request: AgentRequest): Promise<AgentResult> {
    const startedAt = Date.now();
    const baseResult: AgentResult = {
      requestId: request.requestId,
      conversationId: request.conversationId,
      status: 'pending',
      startedAt,
    };

    // 1. Validate the request.
    const validationError = this.validateRequest(request);
    if (validationError) {
      return { ...baseResult, status: 'failed', error: validationError, finishedAt: Date.now() };
    }

    // 2. Reject duplicate submissions (idempotency).
    if (this.recentRequestIds.has(request.requestId)) {
      return {
        ...baseResult,
        status: 'failed',
        error: {
          code: 'duplicate_submission',
          message: 'This request was already submitted.',
        },
        finishedAt: Date.now(),
      };
    }
    this.recentRequestIds.add(request.requestId);
    // Keep the set bounded.
    if (this.recentRequestIds.size > 100) {
      const first = this.recentRequestIds.values().next().value;
      if (first) this.recentRequestIds.delete(first);
    }

    // 3. Reject overlapping runs for the same conversation.
    if (this.active.has(request.conversationId)) {
      return {
        ...baseResult,
        status: 'failed',
        error: {
          code: 'duplicate_submission',
          message: 'A run is already in progress for this conversation.',
        },
        finishedAt: Date.now(),
      };
    }

    const controller = new AbortController();
    if (request.signal) {
      if (request.signal.aborted) {
        return {
          ...baseResult,
          status: 'cancelled',
          error: { code: 'cancelled', message: 'Request was cancelled before start.' },
          finishedAt: Date.now(),
        };
      }
      request.signal.addEventListener('abort', () => controller.abort());
    }
    this.active.set(request.conversationId, {
      status: 'running',
      controller,
      startedAt,
    });

    try {
      return await this.executeRun(request, controller, startedAt);
    } finally {
      this.active.delete(request.conversationId);
    }
  }

  /** Cancel an in-progress run for a conversation, if any. */
  cancel(conversationId: string): boolean {
    const state = this.active.get(conversationId);
    if (!state) return false;
    state.controller.abort();
    state.status = 'cancelled';
    return true;
  }

  /** Whether a run is currently active for a conversation. */
  isRunning(conversationId: string): boolean {
    return this.active.has(conversationId);
  }

  // --- internals ---

  private validateRequest(req: AgentRequest): AgentError | null {
    if (!req.conversationId || typeof req.conversationId !== 'string') {
      return { code: 'invalid_request', message: 'conversationId is required.' };
    }
    if (!req.message || !req.message.trim()) {
      return { code: 'invalid_request', message: 'Message cannot be empty.' };
    }
    if (req.message.length > 32_000) {
      return { code: 'invalid_request', message: 'Message is too long (max 32000 characters).' };
    }
    if (!req.requestId) {
      return { code: 'invalid_request', message: 'requestId is required.' };
    }
    return null;
  }

  private async executeRun(
    req: AgentRequest,
    controller: AbortController,
    startedAt: number,
  ): Promise<AgentResult> {
    const { repositories } = this.opts;
    const base: AgentResult = {
      requestId: req.requestId,
      conversationId: req.conversationId,
      status: 'running',
      startedAt,
    };

    // 1. Resolve the provider.
    const providerId = req.config.providerId;
    let provider: AIProvider | null = null;
    const allowSim = req.config.allowSimulation === true;

    if (allowSim && this.opts.devProvider) {
      provider = this.opts.devProvider;
    } else {
      provider = this.opts.resolveProvider(providerId);
    }

    if (!provider) {
      return {
        ...base,
        status: 'failed',
        error: { code: 'provider_unavailable', message: `No provider adapter for "${providerId}".` },
        finishedAt: Date.now(),
      };
    }

    // 2. Validate readiness.
    const ready = await provider.isReady().catch(() => false);
    if (!ready) {
      return {
        ...base,
        status: 'failed',
        error: {
          code: 'provider_not_ready',
          message: allowSim
            ? 'The development provider is not ready.'
            : `Provider "${providerId}" is not connected. Configure an API key in Settings, or enable development simulation.`,
        },
        finishedAt: Date.now(),
      };
    }

    // 3. Validate model against capabilities.
    const caps = provider.capabilities();
    if (caps.models.length > 0 && !caps.models.includes(req.config.model)) {
      return {
        ...base,
        status: 'failed',
        error: {
          code: 'invalid_request',
          message: `Model "${req.config.model}" is not supported by provider "${providerId}".`,
        },
        finishedAt: Date.now(),
      };
    }

    // 4. Persist the user message FIRST (authoritative path).
    let userMessage: AgentMessage;
    try {
      const saved = await repositories.messages.append({
        conversationId: req.conversationId,
        role: 'user',
        content: req.message,
      });
      userMessage = toAgentMessage(saved);
    } catch (err) {
      return {
        ...base,
        status: 'failed',
        error: {
          code: 'persistence_failed',
          message: 'Failed to save your message. Please try again.',
        },
        finishedAt: Date.now(),
      };
    }

    // 5. Load history (excluding the message we just saved).
    let history: AgentMessage[];
    try {
      const all = await repositories.messages.list(req.conversationId);
      history = all.filter((m) => m.id !== userMessage.id).map(toAgentMessage);
    } catch (err) {
      // History load failure: the user message is saved but we can't build context.
      return {
        ...base,
        status: 'failed',
        userMessage,
        error: { code: 'persistence_failed', message: 'Failed to load conversation history.' },
        finishedAt: Date.now(),
      };
    }

    // 5b. Retrieve memory + knowledge scoped to the active project (Phase 7).
    // Retrieval failure is swallowed — the run continues without retrieved
    // context. The block is framed as reference material, never as instructions
    // that could override the system prompt.
    let retrieval: RetrievalMeta | undefined;
    let retrievedBlock = '';
    const retrievalBudget =
      req.config.maxRetrievalChars ?? this.opts.defaultMaxRetrievalChars ?? DEFAULT_RETRIEVAL_BUDGET_CHARS;
    if (retrievalBudget > 0) {
      try {
        const items = await this.retrieve(req.message, req.config.projectId ?? null, retrievalBudget);
        if (items.length > 0) {
          retrievedBlock = renderContextBlock(items);
          retrieval = { items, chars: retrievedBlock.length };
        }
      } catch {
        // Retrieval must never fail the run.
      }
    }

    // 6. Build context (includes the retrieved block as a labeled reference
    //    system message, accounted for in the character budget).
    const ctx: BuiltContext = buildContext({
      system: req.config.systemPrompt
        ? { content: req.config.systemPrompt, source: 'user' }
        : this.opts.defaultSystemPrompt
          ? { content: this.opts.defaultSystemPrompt, source: 'default' }
          : undefined,
      history,
      currentMessage: userMessage,
      maxContextChars: req.config.maxContextChars ?? this.opts.defaultMaxContextChars,
      maxHistoryMessages: req.config.maxHistoryMessages ?? this.opts.defaultMaxHistoryMessages,
      retrievedContext: retrievedBlock,
    });

    // 7. Execute through the provider.
    const execReq: ProviderExecuteRequest = {
      conversationId: req.conversationId,
      messages: ctxToProviderMessages(ctx),
      model: req.config.model,
      signal: controller.signal,
      timeoutMs: req.config.timeoutMs ?? this.opts.defaultTimeoutMs,
    };

    // Update active state.
    const state = this.active.get(req.conversationId);
    if (state) state.status = 'provider_in_progress';

    let execResp;
    try {
      execResp = await runWithTimeout(
        provider.execute(execReq),
        execReq.timeoutMs,
        controller.signal,
      );
    } catch (err) {
      return this.handleProviderError(err, base, userMessage, controller.signal);
    }

    // Check cancellation after provider returns.
    if (controller.signal.aborted) {
      return {
        ...base,
        status: 'cancelled',
        userMessage,
        error: { code: 'cancelled', message: 'Request was cancelled.' },
        finishedAt: Date.now(),
      };
    }

    // 8. Handle tool calls — Phase 5 does not execute tools.
    if (execResp.toolCalls && execResp.toolCalls.length > 0) {
      const firstCall = execResp.toolCalls[0] as ToolCall;
      const toolResult = unsupportedToolResult(firstCall);
      // Persist an assistant message describing the unsupported request.
      const assistantContent = `The model requested a tool call (${firstCall.toolId}), but tool execution is not enabled in this phase.`;
      let assistantMessage: AgentMessage | undefined;
      try {
        const saved = await repositories.messages.append({
          conversationId: req.conversationId,
          role: 'assistant',
          content: assistantContent,
        });
        assistantMessage = toAgentMessage(saved);
      } catch {
        // Persistence failure on the assistant side is non-fatal to history.
      }
      return {
        ...base,
        status: 'failed',
        userMessage,
        assistantMessage,
        error: toolResult.error!,
        meta: execResp.meta,
        finishedAt: Date.now(),
      };
    }

    // 9. Persist the assistant message (authoritative path).
    let assistantMessage: AgentMessage;
    try {
      const saved = await repositories.messages.append({
        conversationId: req.conversationId,
        role: 'assistant',
        content: execResp.content,
      });
      assistantMessage = toAgentMessage(saved);
    } catch (err) {
      return {
        ...base,
        status: 'failed',
        userMessage,
        error: {
          code: 'persistence_failed',
          message: 'The provider responded, but saving the response failed.',
        },
        meta: execResp.meta,
        finishedAt: Date.now(),
      };
    }

    // Mark simulated flag on the persisted message shape for the UI.
    if (execResp.meta.simulated) {
      assistantMessage = { ...assistantMessage, simulated: true };
    }

    return {
      ...base,
      status: 'completed',
      userMessage,
      assistantMessage,
      meta: execResp.meta,
      retrieval,
      finishedAt: Date.now(),
    };
  }

  /**
   * Retrieve memory + knowledge relevant to the user message, scoped to the
   * active project. Loads both stores via the repository contracts and ranks
   * them with the shared text-overlap retriever. Retrieval failures are
   * swallowed by the caller.
   */
  private async retrieve(
    message: string,
    projectId: string | null,
    budgetChars: number,
  ): Promise<RetrievedContextItem[]> {
    const { repositories } = this.opts;
    const [memResult, kbResult] = await Promise.all([
      repositories.memories
        .list({ projectId: projectId ?? undefined, activeOnly: true, limit: 200 })
        .catch(() => ({ items: [], total: 0 })),
      repositories.knowledge
        .list({ projectId: projectId ?? undefined, activeOnly: true, limit: 200 })
        .catch(() => ({ items: [], total: 0 })),
    ]);
    return retrieveContext({
      message,
      projectId,
      memories: memResult.items,
      knowledge: kbResult.items,
      budgetChars,
    });
  }

  private handleProviderError(
    err: unknown,
    base: AgentResult,
    userMessage: AgentMessage,
    signal: AbortSignal,
  ): AgentResult {
    if (err instanceof ProviderError) {
      const agentErr = err.toAgentError();
      const status: RunStatus =
        agentErr.code === 'cancelled' || signal.aborted ? 'cancelled' : 'failed';
      return {
        ...base,
        status,
        userMessage,
        error: agentErr,
        finishedAt: Date.now(),
      };
    }
    if (signal.aborted) {
      return {
        ...base,
        status: 'cancelled',
        userMessage,
        error: { code: 'cancelled', message: 'Request was cancelled.' },
        finishedAt: Date.now(),
      };
    }
    const message = err instanceof Error ? err.message.slice(0, 500) : 'Provider execution failed.';
    return {
      ...base,
      status: 'failed',
      userMessage,
      error: { code: 'provider_failed', message },
      finishedAt: Date.now(),
    };
  }
}

// --- helpers ---

function toAgentMessage(m: {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: number;
}): AgentMessage {
  return { id: m.id, role: m.role, content: m.content, createdAt: m.createdAt };
}

function ctxToProviderMessages(ctx: BuiltContext) {
  return ctx.messages.map((m) => ({
    role: m.role,
    content: m.content,
    toolCallId: m.toolCallId,
    toolName: m.toolName,
  }));
}

/** Run a promise with a timeout. Respects an external abort signal. */
function runWithTimeout<T>(
  p: Promise<T>,
  timeoutMs: number | undefined,
  signal: AbortSignal,
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ProviderError('timeout', 'The provider request timed out.'));
    }, timeoutMs);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new ProviderError('aborted', 'Request was cancelled.'));
      },
      { once: true },
    );
  });
}
