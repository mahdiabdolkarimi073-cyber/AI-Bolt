import type { ProviderId } from '@/types';
import type {
  AIProvider,
  ChatRequest,
  ChatChunk,
  ProviderCapabilities,
  ProviderExecuteRequest,
  ProviderExecuteResponse,
} from './aiProvider';
import { ProviderError } from './aiProvider';

/**
 * A no-op provider adapter used until real adapters are wired in (Phase 6).
 *
 * It is intentionally safe:
 *   - never makes network calls,
 *   - never reads or transmits API keys,
 *   - reports `isReady() === false` so callers can show a clear "not connected" state,
 *   - `execute()` throws a `ProviderError` with code `not_ready` rather than
 *     fabricating a response.
 *
 * This keeps the provider layer stable and replaceable: later phases swap
 * this stub for a real adapter (e.g. GeminiAdapter) without touching callers.
 */
export class StubProvider implements AIProvider {
  readonly id: ProviderId;
  readonly displayName: string;

  constructor(id: ProviderId, displayName: string) {
    this.id = id;
    this.displayName = displayName;
  }

  async isReady(): Promise<boolean> {
    return false;
  }

  capabilities(): ProviderCapabilities {
    return {
      models: [],
      supportsStreaming: false,
      supportsToolCalls: false,
      simulated: false,
    };
  }

  async execute(_req: ProviderExecuteRequest): Promise<ProviderExecuteResponse> {
    throw new ProviderError(
      'not_ready',
      `${this.displayName} is not connected. Configure an API key in Settings to enable it.`,
    );
  }

  async *stream(_req: ChatRequest): AsyncIterable<ChatChunk> {
    yield {
      delta: 'This provider is not connected yet. Configure an API key in Settings to enable it.',
      done: true,
    };
  }
}

export const stubProviders: Record<ProviderId, () => AIProvider> = {
  gemini: () => new StubProvider('gemini', 'Gemini'),
  groq: () => new StubProvider('groq', 'GroqCloud'),
  cerebras: () => new StubProvider('cerebras', 'Cerebras'),
  openrouter: () => new StubProvider('openrouter', 'OpenRouter'),
};
