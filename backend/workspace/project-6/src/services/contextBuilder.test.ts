import { describe, it, expect } from 'vitest';
import { buildContext } from '@/services/contextBuilder';
import type { AgentMessage } from '@/types/agent';

function msg(id: string, role: AgentMessage['role'], content: string, ts = 0): AgentMessage {
  return { id, role, content, createdAt: ts };
}

describe('buildContext', () => {
  it('includes system, history, and current message in order', () => {
    const history = [msg('h1', 'user', 'Hello', 1), msg('h2', 'assistant', 'Hi there', 2)];
    const current = msg('c1', 'user', 'How are you?', 3);
    const result = buildContext({ history, currentMessage: current });
    expect(result.messages).toHaveLength(4);
    expect(result.messages[0].role).toBe('system');
    expect(result.messages[1].content).toBe('Hello');
    expect(result.messages[2].content).toBe('Hi there');
    expect(result.messages[3].content).toBe('How are you?');
    expect(result.truncated).toBe(false);
  });

  it('never drops or truncates the current user message', () => {
    const history = [msg('h1', 'user', 'x'.repeat(100), 1)];
    const current = msg('c1', 'user', 'y'.repeat(200), 2);
    const result = buildContext({ history, currentMessage: current, maxContextChars: 50 });
    const currentMsg = result.messages.find((m) => m.id === 'c1');
    expect(currentMsg).toBeDefined();
    expect(currentMsg!.content).toBe('y'.repeat(200));
  });

  it('drops oldest history first when char budget is exceeded', () => {
    const history = [
      msg('old', 'user', 'x'.repeat(500), 1),
      msg('mid', 'assistant', 'y'.repeat(100), 2),
      msg('new', 'user', 'z'.repeat(50), 3),
    ];
    const current = msg('c1', 'user', 'current', 4);
    const result = buildContext({ history, currentMessage: current, maxContextChars: 300 });
    // 'old' (500 chars) should be dropped; 'mid' and 'new' should be kept.
    const ids = result.messages.map((m) => m.id);
    expect(ids).not.toContain('old');
    expect(ids).toContain('mid');
    expect(ids).toContain('new');
    expect(result.truncated).toBe(true);
    expect(result.droppedHistoryCount).toBeGreaterThanOrEqual(1);
  });

  it('caps history by message count', () => {
    const history = Array.from({ length: 10 }, (_, i) => msg(`h${i}`, 'user', `msg ${i}`, i));
    const current = msg('c1', 'user', 'current', 10);
    const result = buildContext({ history, currentMessage: current, maxHistoryMessages: 3 });
    const historyInResult = result.messages.filter((m) => m.role !== 'system' && m.id !== 'c1');
    expect(historyInResult).toHaveLength(3);
    expect(historyInResult[2].id).toBe('h9');
  });

  it('uses default system prompt when none provided', () => {
    const current = msg('c1', 'user', 'hi', 1);
    const result = buildContext({ history: [], currentMessage: current });
    expect(result.messages[0].role).toBe('system');
    expect(result.messages[0].content).toBeTruthy();
  });

  it('uses user-supplied system prompt when provided', () => {
    const current = msg('c1', 'user', 'hi', 1);
    const result = buildContext({
      system: { content: 'Custom instructions', source: 'user' },
      history: [],
      currentMessage: current,
    });
    expect(result.messages[0].content).toBe('Custom instructions');
  });

  it('reports limit kind as chars when budget set, none otherwise', () => {
    const current = msg('c1', 'user', 'hi', 1);
    const withLimit = buildContext({ history: [], currentMessage: current, maxContextChars: 1000 });
    const noLimit = buildContext({ history: [], currentMessage: current });
    expect(withLimit.limitKind).toBe('chars');
    expect(noLimit.limitKind).toBe('none');
  });
});
