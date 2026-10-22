import { describe, it, expect } from 'vitest';
import { DevProvider } from '@/services/providers/devProvider';
import { ProviderError } from '@/services/providers/aiProvider';
import type { ProviderExecuteRequest } from '@/services/providers/aiProvider';

function makeReq(signal?: AbortSignal): ProviderExecuteRequest {
  return {
    conversationId: 'test-conv',
    messages: [{ role: 'user', content: 'hello' }],
    model: 'dev-simulated',
    signal,
  };
}

describe('DevProvider', () => {
  it('reports isReady true by default', async () => {
    const p = new DevProvider();
    expect(await p.isReady()).toBe(true);
  });

  it('reports simulated capability', () => {
    const p = new DevProvider();
    const caps = p.capabilities();
    expect(caps.simulated).toBe(true);
    expect(caps.models).toContain('dev-simulated');
  });

  it('returns deterministic response content', async () => {
    const p = new DevProvider({ responseContent: 'Test reply' });
    const resp = await p.execute(makeReq());
    expect(resp.content).toBe('Test reply');
    expect(resp.meta.simulated).toBe(true);
    expect(resp.meta.model).toBe('dev-simulated');
  });

  it('throws not_ready when configured as not ready', async () => {
    const p = new DevProvider({ ready: false });
    await expect(p.execute(makeReq())).rejects.toThrow(ProviderError);
    try {
      await p.execute(makeReq());
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError);
      expect((e as ProviderError).code).toBe('not_ready');
    }
  });

  it('throws on aborted signal', async () => {
    const p = new DevProvider();
    const controller = new AbortController();
    controller.abort();
    await expect(p.execute(makeReq(controller.signal))).rejects.toThrow(ProviderError);
  });

  it('honors failWith config', async () => {
    const p = new DevProvider({ failWith: { code: 'test_error', message: 'Injected failure' } });
    await expect(p.execute(makeReq())).rejects.toThrow(ProviderError);
  });

  it('respects cancellation during delay', async () => {
    const p = new DevProvider({ delayMs: 5000 });
    const controller = new AbortController();
    const promise = p.execute(makeReq(controller.signal));
    setTimeout(() => controller.abort(), 50);
    await expect(promise).rejects.toThrow(ProviderError);
  });

  it('produces streaming chunks', async () => {
    const p = new DevProvider({ responseContent: 'hello world test' });
    const chunks: string[] = [];
    for await (const chunk of p.stream({ conversationId: 'c', history: [], message: 'hi' })) {
      if (chunk.delta) chunks.push(chunk.delta);
    }
    const full = chunks.join('');
    expect(full).toBe('hello world test');
  });
});
