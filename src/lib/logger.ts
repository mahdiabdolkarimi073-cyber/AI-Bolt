/**
 * Structured diagnostic logger for the Personal AI IDE frontend.
 *
 * Emits to the browser DevTools Console with consistent prefixes so logs can be
 * correlated with the backend terminal output using a shared request id.
 *
 * Prefixes:
 *   [AI-IDE][CHAT]       — user message submission, request lifecycle
 *   [AI-IDE][MODEL]      — model selection changes, provider metadata
 *   [AI-IDE][CONNECTION] — connection tests, credential operations
 *   [AI-IDE][ERROR]      — errors, timeouts, cancellation
 *
 * Verbose debug logging is gated behind `localStorage.ai_ide_debug === '1'` or
 * the `VITE_DEBUG_LOG` env var. Warnings and errors are always emitted.
 *
 * Security: this module NEVER logs API keys, authorization headers, access
 * tokens, passwords, or full user prompts / AI responses. Callers should pass
 * metadata (lengths, ids, model names) rather than raw content.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

type Prefix = 'CHAT' | 'MODEL' | 'CONNECTION' | 'ERROR';

const PREFIX_TAG: Record<Prefix, string> = {
  CHAT: '[AI-IDE][CHAT]',
  MODEL: '[AI-IDE][MODEL]',
  CONNECTION: '[AI-IDE][CONNECTION]',
  ERROR: '[AI-IDE][ERROR]',
};

function debugEnabled(): boolean {
  try {
    if (import.meta.env.VITE_DEBUG_LOG === '1') return true;
    return localStorage.getItem('ai_ide_debug') === '1';
  } catch {
    return false;
  }
}

function emit(level: LogLevel, prefix: Prefix, message: string, fields?: Record<string, unknown>): void {
  // Errors and warnings are always emitted; debug/info require the flag.
  if (level === 'debug' && !debugEnabled()) return;
  if (level === 'info' && !debugEnabled()) return;

  const tag = PREFIX_TAG[prefix];
  const parts: string[] = [tag, message];
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      parts.push(`${key}=${formatValue(value)}`);
    }
  }
  const line = parts.join(' ');

  switch (level) {
    case 'debug':
      console.debug(line);
      break;
    case 'info':
      console.info(line);
      break;
    case 'warn':
      console.warn(line);
      break;
    case 'error':
      console.error(line);
      break;
  }
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '(none)';
  if (typeof value === 'string') return value || '(empty)';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return String(value);
}

/** Sanitize a string to remove anything that looks like a secret. */
export function redactSecrets(text: string): string {
  if (typeof text !== 'string') return '(non-string)';
  return text
    .replace(/(sk-[A-Za-z0-9-_]{10,})/g, '[redacted]')
    .replace(/(AIza[A-Za-z0-9-_]{20,})/g, '[redacted]')
    .replace(/(Bearer\s+[A-Za-z0-9._-]+)/gi, 'Bearer [redacted]')
    .slice(0, 500);
}

export const logger = {
  debug(prefix: Prefix, message: string, fields?: Record<string, unknown>): void {
    emit('debug', prefix, message, fields);
  },
  info(prefix: Prefix, message: string, fields?: Record<string, unknown>): void {
    emit('info', prefix, message, fields);
  },
  warn(prefix: Prefix, message: string, fields?: Record<string, unknown>): void {
    emit('warn', prefix, message, fields);
  },
  error(prefix: Prefix, message: string, fields?: Record<string, unknown>): void {
    emit('error', prefix, message, fields);
  },
  isDebug: debugEnabled,
};
