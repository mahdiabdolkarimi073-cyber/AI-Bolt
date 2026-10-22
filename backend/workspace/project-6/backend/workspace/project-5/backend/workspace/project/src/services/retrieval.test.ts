import { describe, it, expect } from 'vitest';
import { retrieveContext, renderContextBlock, DEFAULT_RETRIEVAL_BUDGET_CHARS } from '@/services/retrieval';
import type { Memory, KnowledgeEntry } from '@/types/memory';

function mem(over: Partial<Memory> = {}): Memory {
  return {
    id: 'm1',
    type: 'preference',
    title: 'Prefers TypeScript',
    content: 'The user prefers TypeScript over JavaScript for new projects.',
    projectId: null,
    tags: ['typescript', 'preference'],
    importance: 2,
    active: true,
    createdAt: 1,
    updatedAt: 1,
    lastAccessedAt: null,
    ...over,
  };
}

function kb(over: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: 'k1',
    title: 'Auth architecture',
    content: 'The project uses JWT tokens with refresh rotation.',
    category: 'architecture',
    projectId: 'proj-a',
    tags: ['auth', 'jwt'],
    source: null,
    active: true,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

describe('retrieveContext', () => {
  it('returns nothing for an empty message', () => {
    const items = retrieveContext({ message: '', memories: [mem()], knowledge: [] });
    expect(items).toHaveLength(0);
  });

  it('returns nothing when budget is 0', () => {
    const items = retrieveContext({
      message: 'typescript',
      memories: [mem()],
      knowledge: [],
      budgetChars: 0,
    });
    expect(items).toHaveLength(0);
  });

  it('matches personal memories regardless of project', () => {
    const items = retrieveContext({
      message: 'do you remember my typescript preference',
      memories: [mem()],
      knowledge: [],
      projectId: 'proj-a',
    });
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].kind).toBe('memory');
    expect(items[0].id).toBe('m1');
  });

  it('excludes project-scoped knowledge for a different project', () => {
    const items = retrieveContext({
      message: 'auth jwt tokens',
      memories: [],
      knowledge: [kb({ projectId: 'proj-b' })],
      projectId: 'proj-a',
    });
    expect(items).toHaveLength(0);
  });

  it('includes project-scoped knowledge for the matching project', () => {
    const items = retrieveContext({
      message: 'auth jwt tokens',
      memories: [],
      knowledge: [kb({ projectId: 'proj-a' })],
      projectId: 'proj-a',
    });
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].kind).toBe('knowledge');
  });

  it('includes global knowledge (projectId null) regardless of active project', () => {
    const items = retrieveContext({
      message: 'auth jwt tokens',
      memories: [],
      knowledge: [kb({ projectId: null })],
      projectId: 'proj-a',
    });
    expect(items.length).toBeGreaterThan(0);
  });

  it('skips inactive memories and knowledge', () => {
    const items = retrieveContext({
      message: 'typescript preference',
      memories: [mem({ active: false })],
      knowledge: [],
    });
    expect(items).toHaveLength(0);
  });

  it('caps total results to maxResults', () => {
    const memories: Memory[] = [];
    for (let i = 0; i < 20; i++) {
      memories.push(mem({ id: `m${i}`, title: `TypeScript note ${i}`, content: 'typescript typescript typescript' }));
    }
    const items = retrieveContext({ message: 'typescript', memories, knowledge: [], maxResults: 3 });
    expect(items.length).toBeLessThanOrEqual(3);
  });

  it('respects the character budget by truncating content', () => {
    const longContent = 'typescript '.repeat(2000);
    const items = retrieveContext({
      message: 'typescript',
      memories: [mem({ content: longContent })],
      knowledge: [],
      budgetChars: 300,
    });
    expect(items.length).toBeGreaterThan(0);
    const total = items.reduce((s, it) => s + it.content.length, 0);
    expect(total).toBeLessThan(300);
  });

  it('deduplicates by kind+id', () => {
    const m = mem();
    const items = retrieveContext({
      message: 'typescript preference typescript',
      memories: [m, { ...m, title: 'dup' }],
      knowledge: [],
    });
    const ids = items.filter((i) => i.id === 'm1');
    expect(ids.length).toBe(1);
  });

  it('defaults to DEFAULT_RETRIEVAL_BUDGET_CHARS', () => {
    expect(DEFAULT_RETRIEVAL_BUDGET_CHARS).toBe(3500);
  });
});

describe('renderContextBlock', () => {
  it('returns empty string for no items', () => {
    expect(renderContextBlock([])).toBe('');
  });

  it('labels the block as reference-only, not instructions', () => {
    const block = renderContextBlock([
      { kind: 'memory', id: 'm1', title: 'T', content: 'C', projectId: null, score: 1, tags: [] },
    ]);
    expect(block).toContain('reference only');
    expect(block.toLowerCase()).toContain('not');
  });

  it('renders memory and knowledge entries with labels', () => {
    const block = renderContextBlock([
      { kind: 'memory', id: 'm1', title: 'TS pref', content: 'prefers TS', projectId: null, score: 1, tags: ['ts'] },
      { kind: 'knowledge', id: 'k1', title: 'Auth', content: 'uses JWT', projectId: 'p1', score: 1, tags: [] },
    ]);
    expect(block).toContain('Memory');
    expect(block).toContain('Knowledge');
    expect(block).toContain('TS pref');
    expect(block).toContain('Auth');
    expect(block).toContain('#ts');
  });
});
