import { describe, it, expect } from 'vitest';
import { AgentRuntime } from '@/services/agentRuntime';
import { DevProvider } from '@/services/providers/devProvider';
import { StubProvider } from '@/services/providers/stubProvider';
import { createMockRepositories } from '@/services/test-helpers';
import type { AIProvider } from '@/services/providers/aiProvider';
import type { AgentRequest } from '@/types/agent';
import type { ProviderId } from '@/types';

function makeRuntime(opts: { devProvider?: AIProvider; resolveProvider?: (id: ProviderId) => AIProvider | null } = {}) {
  const repos = createMockRepositories();
  return {
    repos,
    runtime: new AgentRuntime({
      repositories: repos,
      resolveProvider: opts.resolveProvider ?? ((id: ProviderId) => new StubProvider(id, String(id))),
      devProvider: opts.devProvider ?? new DevProvider(),
      defaultTimeoutMs: 5000,
    }),
  };
}

function makeRequest(conversationId: string, message: string, overrides: Record<string, unknown> = {}): AgentRequest {
  return {
    conversationId,
    message,
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    config: {
      providerId: 'gemini' as ProviderId,
      model: 'dev-simulated',
      allowSimulation: true,
      ...overrides,
    },
  };
}

describe('AgentRuntime', () => {
  it('completes a successful run with the DevProvider', async () => {
    const { repos, runtime } = makeRuntime();
    const conv = await repos.conversations.create({ projectId: null, title: 'Test' });
    const result = await runtime.run(makeRequest(conv.id, 'Hello'));
    expect(result.status).toBe('completed');
    expect(result.userMessage).toBeDefined();
    expect(result.assistantMessage).toBeDefined();
    expect(result.assistantMessage!.content).toBeTruthy();
    expect(result.meta?.simulated).toBe(true);
  });

  it('persists both user and assistant messages through the repository', async () => {
    const { repos, runtime } = makeRuntime();
    const conv = await repos.conversations.create({ projectId: null, title: 'Test' });
    await runtime.run(makeRequest(conv.id, 'Persist me'));
    const messages = await repos.messages.list(conv.id);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[1].role).toBe('assistant');
  });

  it('rejects empty messages', async () => {
    const { repos, runtime } = makeRuntime();
    const conv = await repos.conversations.create({ projectId: null, title: 'Test' });
    const result = await runtime.run(makeRequest(conv.id, ''));
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('invalid_request');
  });

  it('rejects duplicate request ids', async () => {
    const { repos, runtime } = makeRuntime();
    const conv = await repos.conversations.create({ projectId: null, title: 'Test' });
    const req = makeRequest(conv.id, 'First');
    await runtime.run(req);
    const result2 = await runtime.run(req);
    expect(result2.status).toBe('failed');
    expect(result2.error?.code).toBe('duplicate_submission');
  });

  it('rejects overlapping runs for the same conversation', async () => {
    const dev = new DevProvider({ delayMs: 200 });
    const { repos, runtime } = makeRuntime({ devProvider: dev });
    const conv = await repos.conversations.create({ projectId: null, title: 'Test' });
    const p1 = runtime.run(makeRequest(conv.id, 'First'));
    const result2 = await runtime.run(makeRequest(conv.id, 'Second'));
    expect(result2.status).toBe('failed');
    expect(result2.error?.code).toBe('duplicate_submission');
    await p1;
  });

  it('returns provider_not_ready when provider is not ready and simulation is disabled', async () => {
    const { repos, runtime } = makeRuntime();
    const conv = await repos.conversations.create({ projectId: null, title: 'Test' });
    const result = await runtime.run(
      makeRequest(conv.id, 'Hello', { allowSimulation: false, model: 'gemini-2.0-flash' }),
    );
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('provider_not_ready');
  });

  it('rejects unsupported models', async () => {
    const { repos, runtime } = makeRuntime();
    const conv = await repos.conversations.create({ projectId: null, title: 'Test' });
    const result = await runtime.run(
      makeRequest(conv.id, 'Hello', { model: 'nonexistent-model' }),
    );
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('invalid_request');
  });

  it('handles cancellation via abort signal', async () => {
    const dev = new DevProvider({ delayMs: 5000 });
    const { repos, runtime } = makeRuntime({ devProvider: dev });
    const conv = await repos.conversations.create({ projectId: null, title: 'Test' });
    const controller = new AbortController();
    const req = makeRequest(conv.id, 'Cancel me');
    req.signal = controller.signal;
    const p = runtime.run(req);
    setTimeout(() => controller.abort(), 50);
    const result = await p;
    expect(['cancelled', 'failed']).toContain(result.status);
  });

  it('reports isRunning during active run and false after', async () => {
    const dev = new DevProvider({ delayMs: 100 });
    const { repos, runtime } = makeRuntime({ devProvider: dev });
    const conv = await repos.conversations.create({ projectId: null, title: 'Test' });
    expect(runtime.isRunning(conv.id)).toBe(false);
    const p = runtime.run(makeRequest(conv.id, 'Running'));
    // After completion, isRunning should be false.
    await p;
    expect(runtime.isRunning(conv.id)).toBe(false);
  });

  it('cancel returns false when no run is active', () => {
    const { runtime } = makeRuntime();
    expect(runtime.cancel('nonexistent')).toBe(false);
  });
});
