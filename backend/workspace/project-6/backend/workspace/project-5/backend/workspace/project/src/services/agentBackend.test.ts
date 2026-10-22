import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/config', () => ({
  config: {
    apiBaseUrl: 'http://localhost:8000',
    backendEnabled: true,
    defaultProvider: 'gemini',
    requestTimeoutMs: 15000,
  },
}));

import { runAgentViaBackend } from '@/services/agentBackend';
import type { AgentConfig } from '@/types/agent';

function mockFetch(body: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status,
    headers: { get: () => 'application/json' },
    json: () => Promise.resolve(body),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('agentBackend connection routing', () => {
  it('passes connectionId through to the backend', async () => {
    const fetchMock = mockFetch({
      requestId: 'r1',
      conversationId: 'c1',
      status: 'completed',
      userMessage: { id: 'm1', conversationId: 'c1', role: 'user', content: 'hi', createdAt: 1 },
      assistantMessage: { id: 'm2', conversationId: 'c1', role: 'assistant', content: 'hello', createdAt: 2 },
      meta: { providerId: 'gemini', connectionId: 'conn-1', model: 'gemini-2.0-flash', simulated: false, finishReason: 'stop' },
      startedAt: 1,
      finishedAt: 2,
    });
    const config: AgentConfig = {
      providerId: 'gemini',
      model: 'gemini-2.0-flash',
      connectionId: 'conn-1',
    };
    const { data, error } = await runAgentViaBackend({ conversationId: 'c1', message: 'hi', config });
    expect(error).toBeNull();
    expect(data?.status).toBe('completed');
    expect(data?.meta?.simulated).toBe(false);
    expect(data?.meta?.connectionId).toBe('conn-1');
    const call = fetchMock.mock.calls[0];
    expect(typeof call[1].body).toBe('string');
    expect(call[1].body).toContain('"connectionId":"conn-1"');
  });

  it('marks assistant messages simulated when the backend reports it', async () => {
    mockFetch({
      requestId: 'r2',
      conversationId: 'c2',
      status: 'completed',
      userMessage: { id: 'm1', conversationId: 'c2', role: 'user', content: 'hi', createdAt: 1 },
      assistantMessage: { id: 'm2', conversationId: 'c2', role: 'assistant', content: 'sim', createdAt: 2 },
      meta: { providerId: 'dev', model: 'dev-simulated', simulated: true, finishReason: 'stop' },
      startedAt: 1,
      finishedAt: 2,
    });
    const config: AgentConfig = { providerId: 'gemini', model: 'dev-simulated', allowSimulation: true };
    const { data } = await runAgentViaBackend({ conversationId: 'c2', message: 'hi', config });
    expect(data?.assistantMessage?.simulated).toBe(true);
  });

  it('surfaces a provider_not_configured error without fabricating a response', async () => {
    mockFetch({
      requestId: 'r3',
      conversationId: 'c3',
      status: 'failed',
      userMessage: { id: 'm1', conversationId: 'c3', role: 'user', content: 'hi', createdAt: 1 },
      error: { code: 'provider_not_configured', message: 'No AI connection is configured.' },
      startedAt: 1,
      finishedAt: 2,
    }, true, 200);
    const config: AgentConfig = { providerId: 'gemini', model: 'gemini-2.0-flash' };
    const { data, error } = await runAgentViaBackend({ conversationId: 'c3', message: 'hi', config });
    expect(data?.status).toBe('failed');
    expect(data?.error?.code).toBe('provider_not_ready');
    expect(data?.assistantMessage).toBeUndefined();
    // error envelope is null because the HTTP call succeeded; the failure is in the body.
    expect(error).toBeNull();
  });
});
