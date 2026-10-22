import type { ApiError } from '@/types/domain';

/** Build a normalized ApiError from an unknown thrown value. */
export function toApiError(err: unknown, fallbackCode = 'unknown'): ApiError {
  if (err instanceof ApiErrorClass) return err.toJSON();
  if (err instanceof Error) {
    return { code: fallbackCode, message: err.message };
  }
  return { code: fallbackCode, message: 'An unknown error occurred' };
}

/** Error class carrying a code + http status, normalized to ApiError. */
export class ApiErrorClass extends Error {
  readonly code: string;
  readonly status?: number;
  readonly details?: unknown;

  constructor(code: string, message: string, status?: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  toJSON(): ApiError {
    return { code: this.code, message: this.message, status: this.status, details: this.details };
  }

  static fromResponse(status: number, body: unknown): ApiErrorClass {
    const detail =
      typeof body === 'object' && body !== null && 'detail' in body
        ? (body as { detail: unknown }).detail
        : body;
    const message =
      typeof detail === 'string'
        ? detail
        : typeof detail === 'object' && detail !== null && 'message' in detail
        ? String((detail as { message: unknown }).message)
        : `Request failed (${status})`;
    const code = statusToCode(status);
    return new ApiErrorClass(code, message, status, detail);
  }

  static network(err: unknown): ApiErrorClass {
    return new ApiErrorClass('network', 'Could not reach the local backend.', undefined, err);
  }

  static timeout(): ApiErrorClass {
    return new ApiErrorClass('timeout', 'The request timed out.');
  }
}

function statusToCode(status: number): string {
  if (status === 401 || status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 422) return 'validation';
  if (status >= 500) return 'server';
  if (status >= 400) return 'client';
  return 'unknown';
}
