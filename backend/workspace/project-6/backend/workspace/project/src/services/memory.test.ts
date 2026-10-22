import { describe, it, expect, beforeEach } from 'vitest';
import { setRepositoriesForTesting } from '@/services/index';
import { createMockRepositories } from '@/services/test-helpers';
import type { Repositories } from '@/services/repositories';
import {
  listMemories,
  createMemory,
  updateMemory,
  deleteMemory,
  listKnowledge,
  createKnowledge,
  updateKnowledge,
  deleteKnowledge,
} from '@/services/memoryService';

let repos: Repositories;

beforeEach(() => {
  repos = createMockRepositories();
  setRepositoriesForTesting(repos);
});

describe('memoryService + inMemory repositories', () => {
  it('creates and retrieves a memory', async () => {
    const { data, error } = await createMemory({
      type: 'preference',
      title: 'Prefers dark theme',
      content: 'Always use dark theme in editors.',
      tags: ['ui', 'theme'],
    });
    expect(error).toBeNull();
    expect(data).toBeDefined();
    expect(data!.title).toBe('Prefers dark theme');
    expect(data!.tags).toEqual(['ui', 'theme']);
    expect(data!.projectId).toBeNull();
    expect(data!.active).toBe(true);
  });

  it('lists memories scoped to personal (no projectId)', async () => {
    await createMemory({ type: 'note', title: 'Personal note', content: 'global' });
    await createMemory({ type: 'note', title: 'Project note', content: 'scoped', projectId: 'p1' });
    const { data } = await listMemories({ projectId: null });
    expect(data!.items.every((m) => m.projectId === null)).toBe(true);
  });

  it('lists memories scoped to a project (includes global)', async () => {
    await createMemory({ type: 'note', title: 'Personal', content: 'global' });
    await createMemory({ type: 'note', title: 'ProjA', content: 'scoped', projectId: 'projA' });
    await createMemory({ type: 'note', title: 'ProjB', content: 'scoped', projectId: 'projB' });
    const { data } = await listMemories({ projectId: 'projA' });
    const titles = data!.items.map((m) => m.title);
    expect(titles).toContain('Personal');
    expect(titles).toContain('ProjA');
    expect(titles).not.toContain('ProjB');
  });

  it('lists all memories with projectId=all', async () => {
    await createMemory({ type: 'note', title: 'P', content: 'global' });
    await createMemory({ type: 'note', title: 'Q', content: 'scoped', projectId: 'x' });
    const { data } = await listMemories({ projectId: 'all' });
    expect(data!.items.length).toBeGreaterThanOrEqual(2);
  });

  it('searches memories by title and content', async () => {
    await createMemory({ type: 'fact', title: 'React version', content: 'Uses React 18' });
    await createMemory({ type: 'fact', title: 'Node version', content: 'Uses Node 20' });
    const { data } = await listMemories({ search: 'React', projectId: 'all' });
    expect(data!.items.some((m) => m.title.includes('React'))).toBe(true);
    expect(data!.items.some((m) => m.title.includes('Node'))).toBe(false);
  });

  it('updates a memory', async () => {
    const { data } = await createMemory({ type: 'note', title: 'Old', content: 'old content' });
    const { data: updated, error } = await updateMemory(data!.id, {
      title: 'New title',
      importance: 5,
      active: false,
    });
    expect(error).toBeNull();
    expect(updated!.title).toBe('New title');
    expect(updated!.importance).toBe(5);
    expect(updated!.active).toBe(false);
  });

  it('deletes a memory', async () => {
    const { data } = await createMemory({ type: 'note', title: 'Temp', content: 'temp' });
    const { error } = await deleteMemory(data!.id);
    expect(error).toBeNull();
    const { data: list } = await listMemories({ projectId: 'all', activeOnly: false });
    expect(list!.items.find((m) => m.id === data!.id)).toBeUndefined();
  });

  it('rejects content that looks like a secret', async () => {
    const { error } = await createMemory({
      type: 'note',
      title: 'Leaked key',
      content: 'sk-1234567890abcdefKEY',
    });
    expect(error).toBeDefined();
    expect(error!.message).toMatch(/secret/i);
  });

  it('normalizes tags (lowercase, deduped)', async () => {
    const { data } = await createMemory({
      type: 'note',
      title: 'Tags test',
      content: 'content',
      tags: ['React', 'react', '  TypeScript  '],
    });
    expect(data!.tags).toEqual(['react', 'typescript']);
  });

  it('filters by type', async () => {
    await createMemory({ type: 'preference', title: 'A', content: 'a' });
    await createMemory({ type: 'decision', title: 'B', content: 'b' });
    const { data } = await listMemories({ type: 'decision', projectId: 'all' });
    expect(data!.items.every((m) => m.type === 'decision')).toBe(true);
  });
});

describe('knowledgeService + inMemory repositories', () => {
  it('creates and retrieves a knowledge entry', async () => {
    const { data, error } = await createKnowledge({
      title: 'Auth architecture',
      content: 'JWT with refresh tokens.',
      category: 'architecture',
      projectId: 'projA',
      tags: ['auth'],
      source: 'docs/arch.md',
    });
    expect(error).toBeNull();
    expect(data!.title).toBe('Auth architecture');
    expect(data!.category).toBe('architecture');
    expect(data!.projectId).toBe('projA');
    expect(data!.source).toBe('docs/arch.md');
  });

  it('scopes knowledge to project (global + project match)', async () => {
    await createKnowledge({ title: 'Global', content: 'g', category: 'note', projectId: null });
    await createKnowledge({ title: 'A', content: 'a', category: 'note', projectId: 'projA' });
    await createKnowledge({ title: 'B', content: 'b', category: 'note', projectId: 'projB' });
    const { data } = await listKnowledge({ projectId: 'projA' });
    const titles = data!.items.map((k) => k.title);
    expect(titles).toContain('Global');
    expect(titles).toContain('A');
    expect(titles).not.toContain('B');
  });

  it('filters by category', async () => {
    await createKnowledge({ title: 'S', content: 's', category: 'summary', projectId: null });
    await createKnowledge({ title: 'L', content: 'l', category: 'limitation', projectId: null });
    const { data } = await listKnowledge({ category: 'limitation', projectId: 'all' });
    expect(data!.items.every((k) => k.category === 'limitation')).toBe(true);
  });

  it('updates a knowledge entry', async () => {
    const { data } = await createKnowledge({ title: 'Old', content: 'old', category: 'note', projectId: null });
    const { data: updated, error } = await updateKnowledge(data!.id, {
      title: 'New',
      category: 'architecture',
      active: false,
    });
    expect(error).toBeNull();
    expect(updated!.title).toBe('New');
    expect(updated!.category).toBe('architecture');
    expect(updated!.active).toBe(false);
  });

  it('deletes a knowledge entry', async () => {
    const { data } = await createKnowledge({ title: 'Temp', content: 't', category: 'note', projectId: null });
    const { error } = await deleteKnowledge(data!.id);
    expect(error).toBeNull();
    const { data: list } = await listKnowledge({ projectId: 'all', activeOnly: false });
    expect(list!.items.find((k) => k.id === data!.id)).toBeUndefined();
  });

  it('rejects secret content in knowledge', async () => {
    const { error } = await createKnowledge({
      title: 'creds',
      content: 'password=supersecret123',
      category: 'note',
    });
    expect(error).toBeDefined();
    expect(error!.message).toMatch(/secret/i);
  });

  it('searches knowledge entries', async () => {
    await createKnowledge({ title: 'Deploy', content: 'uses docker compose', category: 'documentation', projectId: null });
    await createKnowledge({ title: 'CI', content: 'uses github actions', category: 'documentation', projectId: null });
    const { data } = await listKnowledge({ search: 'docker', projectId: 'all' });
    expect(data!.items.some((k) => k.title === 'Deploy')).toBe(true);
    expect(data!.items.some((k) => k.title === 'CI')).toBe(false);
  });
});

describe('repository availability', () => {
  it('exposes memories and knowledge on the repositories object', () => {
    expect(repos.memories).toBeDefined();
    expect(repos.knowledge).toBeDefined();
    expect(typeof repos.memories.list).toBe('function');
    expect(typeof repos.knowledge.list).toBe('function');
  });
});
