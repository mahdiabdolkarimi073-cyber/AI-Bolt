import type { ProviderId } from '@/types';
import type { ChatStepRecord } from '@/types/domain';
import type {
  AgentMessage,
  ProviderExecutionMeta,
  TokenUsage,
  AgentError,
} from '@/types/agent';

/**
 * Provider adapter contract. Each AI provider (Gemini, Groq, Cerebras,
 * OpenRouter) gets a concrete adapter that implements this interface.
 *
 * Adapters are the ONLY place that knows how to talk to a specific provider.
 * The rest of the app works against `AIProvider`.
 *
 * Phase 5 extends the contract with a structured `execute` method used by the
 * Agent runtime. The original `stream`/`ChatRequest` shape is preserved for
 * backward compatibility with existing callers; new code should prefer
 * `execute`. Real vendor integrations belong to Phase 6 — adapters in this
 * phase are either stubs (not ready) or the deterministic DevProvider.
 */

// --- Legacy streaming contract (kept for compatibility) ---

export interface ChatRequest {
  conversationId: string;
  /** Sliding window of prior messages, oldest first. */
  history: { role: 'user' | 'assistant' | 'system'; content: string }[];
  /** The new user message. */
  message: string;
  signal?: AbortSignal;
}

export interface ChatChunk {
  delta: string;
  steps?: ChatStepRecord[];
  done: boolean;
}

// --- Structured execution contract (Phase 5) ---

/** Provider-native message shape. Conversion from AgentMessage happens inside
 *  the adapter, not throughout the Agent core. */
export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolName?: string;
}

export interface ProviderExecuteRequest {
  conversationId: string;
  /** Full context in chronological order, including the current user message.
   *  Built by the context builder; the adapter only converts format. */
  messages: ProviderMessage[];
  model: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ProviderExecuteResponse {
  /** The assistant's text response. */
  content: string;
  /** Tool calls requested by the model, if any. In Phase 5 these are not
   *  executed and result in an `unsupported_tool_call` error. */
  toolCalls?: Array<{ id: string; toolId: string; input: unknown }>;
  meta: ProviderExecutionMeta;
}

/** Declared capabilities of a provider adapter. Used by the runtime to
 *  validate model + feature requests without importing vendor SDKs. */
export interface ProviderCapabilities {
  /** Model ids this adapter can serve. Empty means "any" (e.g. dev stub). */
  models: string[];
  /** Whether streaming is supported by this adapter. */
  supportsStreaming: boolean;
  /** Whether tool calls can be requested (execution is a separate concern). */
  supportsToolCalls: boolean;
  /** Whether this adapter is a development/test/simulated provider. */
  simulated: boolean;
}

export interface AIProvider {
  readonly id: ProviderId | 'dev';
  readonly displayName: string;
  /** Whether this provider is ready to serve requests (has key + enabled). */
  isReady(): Promise<boolean>;
  /** Declared capabilities. The runtime validates against these. */
  capabilities(): ProviderCapabilities;
  /** Structured execution used by the Agent runtime. */
  execute(req: ProviderExecuteRequest): Promise<ProviderExecuteResponse>;
  /** Stream a chat completion. Yields incremental chunks.
   *  Implementations that do not support streaming should throw an error with
   *  code `unsupported` so callers can fall back to `execute`. */
  stream(req: ChatRequest): AsyncIterable<ChatChunk>;
}

/** Error thrown by adapters, normalized to a safe shape. */
export class ProviderError extends Error {
  readonly code: string;
  readonly simulated: boolean;
  constructor(code: string, message: string, simulated = false) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.simulated = simulated;
  }
  toAgentError(): AgentError {
    return {
      code:
        this.code === 'timeout'
          ? 'timeout'
          : this.code === 'not_ready'
            ? 'provider_not_ready'
            : this.code === 'unsupported'
              ? 'unsupported_tool_call'
              : 'provider_failed',
      message: this.message.slice(0, 500),
      causeCode: this.code,
    };
  }
}

/** Registry of provider id -> adapter factory. Populated in later phases. */
export type ProviderRegistry = Record<ProviderId, () => AIProvider>;

/** Helper for adapters: convert AgentMessage[] to ProviderMessage[]. */
export function toProviderMessages(messages: AgentMessage[]): ProviderMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
    toolCallId: m.toolCallId,
    toolName: m.toolName,
  }));
}
