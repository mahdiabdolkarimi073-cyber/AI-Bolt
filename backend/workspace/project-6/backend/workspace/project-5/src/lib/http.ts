import { config } from '@/config';
import { ApiErrorClass } from './errors';
import { logger } from './logger';
import type { ApiResult } from '@/types/domain';

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** When true, send `body` as-is (e.g. FormData) without JSON-encoding. */
  raw?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Optional request id for log correlation with the backend. Sent as the
   *  X-Request-Id header and included in frontend log lines. */
  requestId?: string;
  /** Log prefix category for the caller (chat, connection, etc.). */
  logPrefix?: 'CHAT' | 'CONNECTION' | 'MODEL' | 'ERROR';
}

/**
 * Thin fetch wrapper around the local FastAPI backend.
 * - Aborts on a configurable timeout.
 * - Normalizes network, timeout, and HTTP errors into ApiErrorClass.
 * - Returns a typed ApiResult envelope; never throws to the caller.
 * - Emits structured console logs with a request id for backend correlation.
 *
 * When `config.backendEnabled` is false, callers should check before using this
 * — this function will return a `backend_unavailable` error.
 */
export async function request<T>(path: string, opts: RequestOptions = {}): Promise<ApiResult<T>> {
  if (!config.backendEnabled) {
    return {
      data: null,
      error: {
        code: 'backend_unavailable',
        message: 'No backend URL configured. Running in local fallback mode.',
      },
    };
  }

  const { method = 'GET', body, raw = false, signal, timeoutMs = config.requestTimeoutMs, requestId, logPrefix = 'CHAT' } = opts;
  const url = `${config.apiBaseUrl}${path}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) signal.addEventListener('abort', () => controller.abort());

  const isRawBody = raw && body !== undefined;
  const headers: Record<string, string> = {};
  if (body !== undefined && !isRawBody) headers['Content-Type'] = 'application/json';
  if (requestId) headers['X-Request-Id'] = requestId;
  const sendBody =
    body !== undefined ? (isRawBody ? (body as BodyInit) : JSON.stringify(body)) : undefined;

  const startTime = performance.now();
  logger.debug(logPrefix, 'HTTP request', {
    requestId: requestId ?? '(none)',
    method,
    endpoint: path,
  });

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: sendBody,
      signal: controller.signal,
    });

    const isJson = res.headers.get('content-type')?.includes('application/json');
    const payload = isJson ? await res.json().catch(() => null) : null;
    const durationMs = Math.round(performance.now() - startTime);

    if (!res.ok) {
      logger.error(logPrefix, 'HTTP error response', {
        requestId: requestId ?? '(none)',
        endpoint: path,
        http: res.status,
        durationMs,
      });
      return { data: null, error: ApiErrorClass.fromResponse(res.status, payload).toJSON() };
    }

    logger.debug(logPrefix, 'HTTP response received', {
      requestId: requestId ?? '(none)',
      endpoint: path,
      http: res.status,
      durationMs,
    });
    return { data: (payload as T) ?? null, error: null };
  } catch (err) {
    const durationMs = Math.round(performance.now() - startTime);
    if (controller.signal.aborted && !signal?.aborted) {
      logger.error(logPrefix, 'HTTP timeout', {
        requestId: requestId ?? '(none)',
        endpoint: path,
        durationMs,
      });
      return { data: null, error: ApiErrorClass.timeout().toJSON() };
    }
    if (signal?.aborted) {
      logger.warn(logPrefix, 'HTTP request cancelled', {
        requestId: requestId ?? '(none)',
        endpoint: path,
        durationMs,
      });
      return { data: null, error: ApiErrorClass.network(err).toJSON() };
    }
    logger.error(logPrefix, 'HTTP network error', {
      requestId: requestId ?? '(none)',
      endpoint: path,
      durationMs,
    });
    return { data: null, error: ApiErrorClass.network(err).toJSON() };
  } finally {
    clearTimeout(timer);
  }
}
