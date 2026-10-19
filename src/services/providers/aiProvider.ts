import type { ProviderId } from '@/types';
import type { ChatStepRecord } from '@/types/domain';

/**
 * Provider adapter contract. Each AI provider (Gemini, Groq, Cerebras,
 * OpenRouter) gets a concrete adapter that implements this interface.
 *
 * Adapters are the ONLY place that knows how to talk to a specific provider.
 * The rest of the app works against `AIProvider`.
 *
 * In this phase the adapters are NOT wired to real APIs (no keys, no network
 * calls from the browser). They exist as a stable contract and a safe stub
 * so later phases can fill them in without touching the UI or service layer.
 */

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

export interface AIProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  /** Whether this provider is ready to serve requests (has key + enabled). */
  isReady(): Promise<boolean>;
  /** Stream a chat completion. Yields incremental chunks. */
  stream(req: ChatRequest): AsyncIterable<ChatChunk>;
}

/** Registry of provider id -> adapter factory. Populated in later phases. */
export type ProviderRegistry = Record<ProviderId, () => AIProvider>;
