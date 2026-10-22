import { describe, it, expect, beforeEach, vi } from 'vitest';
import { logger, redactSecrets } from './logger';

// Provide a localStorage mock for the Node test environment.
const _store: Record<string, string> = {};
const localStorageMock = {
  getItem: (key: string) => _store[key] ?? null,
  setItem: (key: string, value: string) => { _store[key] = value; },
  removeItem: (key: string) => { delete _store[key]; },
  clear: () => { for (const k of Object.keys(_store)) delete _store[k]; },
};
vi.stubGlobal('localStorage', localStorageMock);

describe('logger', () => {
  let consoleSpy: { debug: ReturnType<typeof vi.spyOn>; info: ReturnType<typeof vi.spyOn>; warn: ReturnType<typeof vi.spyOn>; error: ReturnType<typeof vi.spyOn> };

  beforeEach(() => {
    consoleSpy = {
      debug: vi.spyOn(console, 'debug').mockImplementation(() => undefined),
      info: vi.spyOn(console, 'info').mockImplementation(() => undefined),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      error: vi.spyOn(console, 'error').mockImplementation(() => undefined),
    };
    localStorage.clear();
  });

  describe('debug gating', () => {
    it('does not emit debug/info logs when debug is disabled', () => {
      logger.debug('CHAT', 'test debug');
      logger.info('CHAT', 'test info');
      expect(consoleSpy.debug).not.toHaveBeenCalled();
      expect(consoleSpy.info).not.toHaveBeenCalled();
    });

    it('emits debug/info logs when localStorage flag is set', () => {
      localStorage.setItem('ai_ide_debug', '1');
      logger.debug('CHAT', 'test debug', { requestId: 'r1' });
      logger.info('CHAT', 'test info', { requestId: 'r1' });
      expect(consoleSpy.debug).toHaveBeenCalledTimes(1);
      expect(consoleSpy.info).toHaveBeenCalledTimes(1);
      expect(consoleSpy.debug.mock.calls[0][0]).toContain('[AI-IDE][CHAT]');
      expect(consoleSpy.info.mock.calls[0][0]).toContain('[AI-IDE][CHAT]');
      expect(consoleSpy.info.mock.calls[0][0]).toContain('requestId=r1');
    });
  });

  describe('warnings and errors always emit', () => {
    it('emits warnings regardless of debug flag', () => {
      logger.warn('CONNECTION', 'test warn', { connectionId: 'c1' });
      expect(consoleSpy.warn).toHaveBeenCalledTimes(1);
      expect(consoleSpy.warn.mock.calls[0][0]).toContain('[AI-IDE][CONNECTION]');
      expect(consoleSpy.warn.mock.calls[0][0]).toContain('connectionId=c1');
    });

    it('emits errors regardless of debug flag', () => {
      logger.error('ERROR', 'test error', { code: 'timeout' });
      expect(consoleSpy.error).toHaveBeenCalledTimes(1);
      expect(consoleSpy.error.mock.calls[0][0]).toContain('[AI-IDE][ERROR]');
      expect(consoleSpy.error.mock.calls[0][0]).toContain('code=timeout');
    });
  });

  describe('prefix correctness', () => {
    it('uses the correct prefix tag for each prefix type', () => {
      localStorage.setItem('ai_ide_debug', '1');
      logger.info('CHAT', 'msg');
      logger.info('MODEL', 'msg');
      logger.info('CONNECTION', 'msg');
      logger.error('ERROR', 'msg');
      expect(consoleSpy.info.mock.calls[0][0]).toContain('[AI-IDE][CHAT]');
      expect(consoleSpy.info.mock.calls[1][0]).toContain('[AI-IDE][MODEL]');
      expect(consoleSpy.info.mock.calls[2][0]).toContain('[AI-IDE][CONNECTION]');
      expect(consoleSpy.error.mock.calls[0][0]).toContain('[AI-IDE][ERROR]');
    });
  });

  describe('field formatting', () => {
    it('formats null/undefined as (none)', () => {
      localStorage.setItem('ai_ide_debug', '1');
      logger.info('CHAT', 'msg', { field1: null, field2: undefined });
      const line = consoleSpy.info.mock.calls[0][0] as string;
      expect(line).toContain('field1=(none)');
      expect(line).toContain('field2=(none)');
    });

    it('formats empty string as (empty)', () => {
      localStorage.setItem('ai_ide_debug', '1');
      logger.info('CHAT', 'msg', { model: '' });
      expect(consoleSpy.info.mock.calls[0][0]).toContain('model=(empty)');
    });

    it('formats numbers and booleans correctly', () => {
      localStorage.setItem('ai_ide_debug', '1');
      logger.info('CHAT', 'msg', { count: 42, ok: true });
      const line = consoleSpy.info.mock.calls[0][0] as string;
      expect(line).toContain('count=42');
      expect(line).toContain('ok=true');
    });
  });
});

describe('redactSecrets', () => {
  it('redacts OpenAI-style API keys (sk-...)', () => {
    const input = 'Error with key sk-abc123def456ghi789jkl012mno345pqr678';
    const result = redactSecrets(input);
    expect(result).not.toContain('sk-abc123');
    expect(result).toContain('[redacted]');
  });

  it('redacts Google-style API keys (AIza...)', () => {
    const input = 'Using key AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ123456789';
    const result = redactSecrets(input);
    expect(result).not.toContain('AIzaSyABCDEF');
    expect(result).toContain('[redacted]');
  });

  it('redacts Bearer tokens', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token';
    const result = redactSecrets(input);
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token');
    expect(result).toContain('Bearer [redacted]');
  });

  it('truncates very long strings', () => {
    const input = 'x'.repeat(1000);
    const result = redactSecrets(input);
    expect(result.length).toBeLessThanOrEqual(500);
  });

  it('returns (non-string) for non-string input', () => {
    expect(redactSecrets(null as unknown as string)).toBe('(non-string)');
    expect(redactSecrets(123 as unknown as string)).toBe('(non-string)');
  });

  it('leaves clean messages unchanged (up to 500 chars)', () => {
    const input = 'AI request completed successfully';
    expect(redactSecrets(input)).toBe(input);
  });
});
