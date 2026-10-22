import { config } from '@/config';
import { ApiErrorClass } from './errors';
import type { ApiResult } from '@/types/domain';

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** When true, send `body` as-is (e.g. FormData) without JSON-encoding. */
  raw?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Thin fetch wrapper around the local FastAPI backend.
 * - Aborts on a configurable timeout.
 * - Normalizes network, timeout, and HTTP errors into ApiErrorClass.
 * - Returns a typed ApiResult envelope; never throws to the caller.
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

  const { method = 'GET', body, raw = false, signal, timeoutMs = config.requestTimeoutMs } = opts;
  const url = `${config.apiBaseUrl}${path}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) signal.addEventListener('abort', () => controller.abort());

  const isRawBody = raw && body !== undefined;
  const headers: Record<string, string> | undefined =
    body !== undefined && !isRawBody ? { 'Content-Type': 'application/json' } : undefined;
  const sendBody =
    body !== undefined ? (isRawBody ? (body as BodyInit) : JSON.stringify(body)) : undefined;

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: sendBody,
      signal: controller.signal,
    });

    const isJson = res.headers.get('content-type')?.includes('application/json');
    const payload = isJson ? await res.json().catch(() => null) : null;

    if (!res.ok) {
      return { data: null, error: ApiErrorClass.fromResponse(res.status, payload).toJSON() };
    }
    return { data: (payload as T) ?? null, error: null };
  } catch (err) {
    if (controller.signal.aborted && !signal?.aborted) {
      return { data: null, error: ApiErrorClass.timeout().toJSON() };
    }
    return { data: null, error: ApiErrorClass.network(err).toJSON() };
  } finally {
    clearTimeout(timer);
  }
}
