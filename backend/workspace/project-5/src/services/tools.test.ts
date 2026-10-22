import { describe, it, expect } from 'vitest';
import { createToolRegistry, unsupportedToolResult, validateAgainstSchema } from '@/services/tools';
import type { ToolCall } from '@/types/agent';

describe('ToolRegistry', () => {
  it('starts empty', () => {
    const reg = createToolRegistry();
    expect(reg.list()).toHaveLength(0);
    expect(reg.get('nonexistent')).toBeNull();
  });

  it('can register and retrieve a tool', () => {
    const reg = createToolRegistry();
    reg.register({
      id: 'read_file',
      description: 'Read a file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      permission: 'read',
    });
    expect(reg.list()).toHaveLength(1);
    expect(reg.get('read_file')).toBeDefined();
  });

  it('validates required fields', () => {
    const reg = createToolRegistry();
    reg.register({
      id: 'read_file',
      description: 'Read a file',
      inputSchema: { type: 'object', required: ['path'] },
      permission: 'read',
    });
    const invalid = reg.validateInput('read_file', {});
    expect(invalid.ok).toBe(false);
    expect(invalid.errors).toContain('Missing required field: path');
    const valid = reg.validateInput('read_file', { path: '/foo' });
    expect(valid.ok).toBe(true);
  });

  it('returns unsupported for unknown tool validation', () => {
    const reg = createToolRegistry();
    const result = reg.validateInput('unknown', {});
    expect(result.ok).toBe(false);
  });
});

describe('unsupportedToolResult', () => {
  it('produces an unsupported result with the correct error code', () => {
    const call: ToolCall = { id: 'tc1', toolId: 'read_file', input: { path: '/foo' } };
    const result = unsupportedToolResult(call);
    expect(result.status).toBe('unsupported');
    expect(result.error?.code).toBe('unsupported_tool_call');
    expect(result.callId).toBe('tc1');
  });
});

describe('validateAgainstSchema', () => {
  it('rejects non-object input for object schema', () => {
    const result = validateAgainstSchema('not an object', { type: 'object' });
    expect(result.ok).toBe(false);
  });

  it('accepts object with all required fields', () => {
    const result = validateAgainstSchema(
      { a: 1, b: 2 },
      { type: 'object', required: ['a', 'b'] },
    );
    expect(result.ok).toBe(true);
  });
});
