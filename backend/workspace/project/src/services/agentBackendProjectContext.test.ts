/**
 * Agent backend client tests (Phase 9).
 *
 * Verifies that projectId is forwarded to POST /agent/run so the backend can
 * scope project-file context retrieval to the active project only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const requestMock = vi.fn();
vi.mock('@/lib/http', () => ({
  request: (...args: unknown[]) => requestMock(...args),
}));

import { runAgentViaBackend } from '@/services/agentBackend';
import type { AgentConfig } from '@/types/agent';
import type { ProviderId } from '@/types';

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    providerId: 'gemini' as ProviderId,
    model: 'gemini-1.5-flash',
    allowSimulation: true,
    ...overrides,
  };
}

beforeEach(() => {
  requestMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('runAgentViaBackend — projectId forwarding', () => {
  it('includes projectId in the request body when provided', async () => {
    requestMock.mockResolvedValue({
      data: {
        requestId: 'r1',
        conversationId: 'c1',
        status: 'completed',
        startedAt: 0,
        finishedAt: 1,
      },
      error: null,
    });
    await runAgentViaBackend({
      conversationId: 'c1',
      message: 'show me App.tsx',
      config: makeConfig({ projectId: 'proj-active' }),
    });
    const [, opts] = requestMock.mock.calls[0];
    expect(opts.body).toMatchObject({ projectId: 'proj-active' });
  });

  it('sends null projectId when not set', async () => {
    requestMock.mockResolvedValue({
      data: {
        requestId: 'r1',
        conversationId: 'c1',
        status: 'completed',
        startedAt: 0,
        finishedAt: 1,
      },
      error: null,
    });
    await runAgentViaBackend({
      conversationId: 'c1',
      message: 'hello',
      config: makeConfig(),
    });
    const [, opts] = requestMock.mock.calls[0];
    expect(opts.body.projectId).toBeNull();
  });

  it('forwards maxRetrievalChars so context bounds are respected', async () => {
    requestMock.mockResolvedValue({
      data: {
        requestId: 'r1',
        conversationId: 'c1',
        status: 'completed',
        startedAt: 0,
        finishedAt: 1,
      },
      error: null,
    });
    await runAgentViaBackend({
      conversationId: 'c1',
      message: 'hello',
      config: makeConfig({ maxRetrievalChars: 1000 }),
    });
    const [, opts] = requestMock.mock.calls[0];
    expect(opts.body.maxRetrievalChars).toBe(1000);
  });

  it('maps a backend error into an AgentResult error', async () => {
    requestMock.mockResolvedValue({
      data: null,
      error: { code: 'provider_not_ready', message: 'No provider configured.', status: 400 },
    });
    const { data, error } = await runAgentViaBackend({
      conversationId: 'c1',
      message: 'hi',
      config: makeConfig(),
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.code).toBe('provider_not_ready');
  });
});
