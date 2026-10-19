import type { ProviderId } from '@/types';
import type { AIProvider, ChatRequest, ChatChunk } from './aiProvider';

/**
 * A no-op provider adapter used until real adapters are wired in.
 *
 * It is intentionally safe:
 *   - never makes network calls,
 *   - never reads or transmits API keys,
 *   - reports `isReady() === false` so callers can show a clear "not connected" state.
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
