import { describe, it, expect } from 'vitest';
import { AgentRuntime } from '@/services/agentRuntime';
import { DevProvider } from '@/services/providers/devProvider';
import { StubProvider } from '@/services/providers/stubProvider';
import { createMockRepositories } from '@/services/test-helpers';
import type { AIProvider } from '@/services/providers/aiProvider';
import type { AgentRequest } from '@/types/agent';
import type { ProviderId } from '@/types';
import { renderContextBlock } from '@/services/retrieval';

function makeRuntime(opts: { devProvider?: AIProvider; captureProvider?: () => AIProvider } = {}) {
  const repos = createMockRepositories();
  let captured: AIProvider | undefined;
  const capture = opts.captureProvider ?? (() => new StubProvider('gemini', 'gemini'));
  const resolver = (id: ProviderId): AIProvider | null => {
    const p = capture();
    captured = p;
    return p;
  };
  return {
    repos,
    runtime: new AgentRuntime({
      repositories: repos,
      resolveProvider: resolver,
      devProvider: opts.devProvider ?? new DevProvider(),
      defaultTimeoutMs: 5000,
    }),
    getCaptured: () => captured,
  };
}

function makeRequest(
  conversationId: string,
  message: string,
  overrides: Record<string, unknown> = {},
): AgentRequest {
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

describe('AgentRuntime retrieval integration (Phase 7)', () => {
  it('populates result.retrieval when a matching memory exists', async () => {
    const { repos, runtime } = makeRuntime();
    const conv = await repos.conversations.create({ projectId: null, title: 'T' });
    await repos.memories.create({
      type: 'preference',
      title: 'Prefers TypeScript',
      content: 'User prefers TypeScript for all new code.',
      tags: ['typescript'],
    });
    const result = await runtime.run(
      makeRequest(conv.id, 'remember my typescript preference'),
    );
    expect(result.status).toBe('completed');
    expect(result.retrieval).toBeDefined();
    expect(result.retrieval!.items.length).toBeGreaterThan(0);
    expect(result.retrieval!.items[0].kind).toBe('memory');
  });

  it('leaves result.retrieval undefined when nothing matches', async () => {
    const { repos, runtime } = makeRuntime();
    const conv = await repos.conversations.create({ projectId: null, title: 'T' });
    const result = await runtime.run(makeRequest(conv.id, 'hello world'));
    expect(result.status).toBe('completed');
    expect(result.retrieval).toBeUndefined();
  });

  it('scopes knowledge retrieval to the active project', async () => {
    const { repos, runtime } = makeRuntime();
    const conv = await repos.conversations.create({ projectId: 'proj-a', title: 'T' });
    await repos.knowledge.create({
      title: 'Auth design',
      content: 'JWT with refresh rotation is the auth design.',
      category: 'architecture',
      projectId: 'proj-b',
      tags: ['auth'],
    });
    // Matching project knowledge
    await repos.knowledge.create({
      title: 'ProjA auth',
      content: 'ProjA uses OAuth2 for auth.',
      category: 'architecture',
      projectId: 'proj-a',
      tags: ['auth'],
    });
    const result = await runtime.run(
      makeRequest(conv.id, 'how does auth work', { projectId: 'proj-a' }),
    );
    expect(result.retrieval).toBeDefined();
    const kbItems = result.retrieval!.items.filter((i) => i.kind === 'knowledge');
    expect(kbItems.length).toBeGreaterThan(0);
    expect(kbItems.every((i) => i.projectId === 'proj-a' || i.projectId === null)).toBe(true);
  });

  it('does not leak other-project knowledge into retrieval', async () => {
    const { repos, runtime } = makeRuntime();
    const conv = await repos.conversations.create({ projectId: 'proj-a', title: 'T' });
    await repos.knowledge.create({
      title: 'Secret B',
      content: 'proj-b secret auth details',
      category: 'architecture',
      projectId: 'proj-b',
      tags: ['auth'],
    });
    const result = await runtime.run(
      makeRequest(conv.id, 'auth details', { projectId: 'proj-a' }),
    );
    const kbItems = (result.retrieval?.items ?? []).filter((i) => i.kind === 'knowledge');
    expect(kbItems.every((i) => i.id !== 'kb-1')).toBe(true);
  });

  it('disables retrieval when maxRetrievalChars is 0', async () => {
    const { repos, runtime } = makeRuntime();
    const conv = await repos.conversations.create({ projectId: null, title: 'T' });
    await repos.memories.create({
      type: 'preference',
      title: 'Prefers dark mode',
      content: 'dark mode preference',
      tags: ['ui'],
    });
    const result = await runtime.run(
      makeRequest(conv.id, 'dark mode preference', { maxRetrievalChars: 0 }),
    );
    expect(result.retrieval).toBeUndefined();
  });

  it('still completes the run when retrieval store throws', async () => {
    const { repos, runtime } = makeRuntime();
    // Replace memories.list with a throwing stub.
    (repos.memories as unknown as { list: () => Promise<never> }).list = async () => {
      throw new Error('db down');
    };
    (repos.knowledge as unknown as { list: () => Promise<never> }).list = async () => {
      throw new Error('db down');
    };
    const conv = await repos.conversations.create({ projectId: null, title: 'T' });
    const result = await runtime.run(makeRequest(conv.id, 'hello'));
    expect(result.status).toBe('completed');
    expect(result.retrieval).toBeUndefined();
  });

  it('renders a context block that is framed as reference, not instructions', async () => {
    const { repos, runtime } = makeRuntime();
    const conv = await repos.conversations.create({ projectId: null, title: 'T' });
    await repos.memories.create({
      type: 'convention',
      title: 'Use tabs not spaces',
      content: 'Always use tabs for indentation.',
      tags: ['style'],
    });
    const result = await runtime.run(makeRequest(conv.id, 'tabs or spaces'));
    expect(result.retrieval).toBeDefined();
    const block = renderContextBlock(result.retrieval!.items);
    expect(block).toContain('reference only');
  });
});
