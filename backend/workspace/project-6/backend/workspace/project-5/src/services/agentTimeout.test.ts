import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/config', () => ({
  config: {
    apiBaseUrl: 'http://localhost:8000',
    backendEnabled: true,
    defaultProvider: 'gemini',
    requestTimeoutMs: 100,
    agentRequestTimeoutMs: 500,
  },
}));

import { runAgentViaBackend } from '@/services/agentBackend';
import type { AgentConfig } from '@/types/agent';

function mockFetchDelayed(body: unknown, delayMs: number, ok = true, status = 200) {
  const fetchMock = vi.fn().mockImplementation((_url, opts) => {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve({
          ok,
          status,
          headers: { get: () => 'application/json' },
          json: () => Promise.resolve(body),
        });
      }, delayMs);
      const signal = opts?.signal as AbortSignal | undefined;
      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      }
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function mockFetchNever() {
  const fetchMock = vi.fn().mockImplementation((_url, opts) => {
    return new Promise((_resolve, reject) => {
      const signal = opts?.signal as AbortSignal | undefined;
      if (signal) {
        signal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      }
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

const completedPayload = {
  requestId: 'r-ok',
  conversationId: 'c1',
  status: 'completed',
  userMessage: { id: 'u1', conversationId: 'c1', role: 'user', content: 'hi', createdAt: 1 },
  assistantMessage: { id: 'a1', conversationId: 'c1', role: 'assistant', content: 'hello', createdAt: 2 },
  meta: { providerId: 'gemini', model: 'gemini-3.6-flash', simulated: false, finishReason: 'stop' },
  startedAt: 1,
  finishedAt: 2,
};

const baseConfig: AgentConfig = { providerId: 'gemini', model: 'gemini-3.6-flash' };

describe('agent timeout lifecycle', () => {
  it('uses the longer agent timeout, not the short global timeout, for /agent/run', async () => {
    // Delay (200ms) exceeds the global requestTimeoutMs (100ms) but fits within
    // the agent timeout (500ms). If the global timeout were applied, this
    // would fail with a timeout error.
    mockFetchDelayed(completedPayload, 200);
    const { data, error } = await runAgentViaBackend({
      conversationId: 'c1',
      message: 'create a file',
      config: baseConfig,
    });
    expect(error).toBeNull();
    expect(data?.status).toBe('completed');
  });

  it('returns a clear timeout error when the provider genuinely times out', async () => {
    // Fetch never resolves; the agent timeout (500ms) fires.
    mockFetchNever();
    const { data, error } = await runAgentViaBackend({
      conversationId: 'c1',
      message: 'hi',
      config: baseConfig,
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe('timeout');
    expect(data).toBeNull();
  });

  it('rejects a late response after user cancellation (AbortSignal)', async () => {
    const fetchMock = mockFetchDelayed(completedPayload, 5000);
    const controller = new AbortController();
    const promise = runAgentViaBackend({
      conversationId: 'c1',
      message: 'hi',
      config: baseConfig,
      signal: controller.signal,
    });
    controller.abort();
    const { data, error } = await promise;
    expect(error).not.toBeNull();
    expect(data).toBeNull();
    expect(fetchMock).toHaveBeenCalled();
  });
});
