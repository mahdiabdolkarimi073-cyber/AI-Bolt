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

/** The development provider uses a pseudo provider id outside the real set. */
type DevProviderId = ProviderId | 'dev';

/**
 * Deterministic development/test provider.
 *
 * This adapter is EXPLICITLY a simulation. It:
 *   - never makes network calls,
 *   - never reads or transmits API keys,
 *   - never masquerades as a real AI model,
 *   - is only selected when `config.allowSimulation === true`,
 *   - produces deterministic, configurable output for automated tests,
 *   - reports `simulated: true` in execution metadata so the UI and logs can
 *     distinguish simulated responses from real model responses.
 *
 * It is NOT a production fallback. If no real provider is configured, the
 * runtime returns a clear "provider not ready" error unless simulation is
 * explicitly allowed by the caller.
 */

export interface DevProviderConfig {
  /** Fixed response content returned on a successful execute. */
  responseContent: string;
  /** When set, execute() throws a ProviderError with this code/message. */
  failWith?: { code: string; message: string };
  /** Delay before responding (ms). Useful for cancellation/timeout tests. */
  delayMs?: number;
  /** When true, the provider reports isReady() === true. */
  ready: boolean;
}

export const DEFAULT_DEV_CONFIG: DevProviderConfig = {
  responseContent:
    '[Simulated response] This is a deterministic development-provider reply. No real model was contacted.',
  ready: true,
};

export class DevProvider implements AIProvider {
  readonly id: DevProviderId = 'dev';
  readonly displayName = 'Development (Simulated)';
  private cfg: DevProviderConfig;

  constructor(cfg: Partial<DevProviderConfig> = {}) {
    this.cfg = { ...DEFAULT_DEV_CONFIG, ...cfg };
  }

  /** Update the configuration (used by tests to simulate failures). */
  configure(cfg: Partial<DevProviderConfig>): void {
    this.cfg = { ...this.cfg, ...cfg };
  }

  async isReady(): Promise<boolean> {
    return this.cfg.ready;
  }

  capabilities(): ProviderCapabilities {
    return {
      models: ['dev-simulated'],
      supportsStreaming: true,
      supportsToolCalls: true,
      simulated: true,
    };
  }

  async execute(req: ProviderExecuteRequest): Promise<ProviderExecuteResponse> {
    if (!this.cfg.ready) {
      throw new ProviderError('not_ready', 'Development provider is not ready.', true);
    }
    // Honor cancellation.
    if (req.signal?.aborted) {
      throw new ProviderError('aborted', 'Request was cancelled.', true);
    }
    // Optional delay — lets tests exercise timeout/cancellation paths.
    if (this.cfg.delayMs && this.cfg.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.cfg.delayMs);
        req.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new ProviderError('aborted', 'Request was cancelled.', true));
        });
      });
    }
    if (req.signal?.aborted) {
      throw new ProviderError('aborted', 'Request was cancelled.', true);
    }
    if (this.cfg.failWith) {
      throw new ProviderError(
        this.cfg.failWith.code,
        this.cfg.failWith.message,
        true,
      );
    }
    return {
      content: this.cfg.responseContent,
      meta: {
        providerId: this.id,
        model: 'dev-simulated',
        simulated: true,
        finishReason: 'stop',
      },
    };
  }

  async *stream(req: ChatRequest): AsyncIterable<ChatChunk> {
    if (!this.cfg.ready) {
      yield {
        delta: 'Development provider is not ready.',
        done: true,
      };
      return;
    }
    // Emit the configured response one word at a time for a realistic stream.
    const words = this.cfg.responseContent.split(' ');
    for (let i = 0; i < words.length; i++) {
      if (req.signal?.aborted) {
        yield { delta: '', done: true };
        return;
      }
      await new Promise((r) => setTimeout(r, 15));
      yield {
        delta: (i === 0 ? '' : ' ') + words[i],
        done: i === words.length - 1,
      };
    }
  }
}
