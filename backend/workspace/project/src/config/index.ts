import type { ProviderId } from '@/types';

/**
 * Central runtime configuration for the frontend.
 * Secrets (API keys) are NEVER read here — they live only on the backend.
 */
export const config = {
  /** Base URL for the local FastAPI backend. Falls back to in-browser fallback mode when unset. */
  apiBaseUrl: (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, ''),
  /** Whether a real backend is configured. When false, services degrade to local fallbacks. */
  backendEnabled: Boolean(import.meta.env.VITE_API_BASE_URL),
  defaultProvider: (import.meta.env.VITE_DEFAULT_PROVIDER ?? 'gemini') as ProviderId,
  requestTimeoutMs: 15_000,
} as const;

export type AppConfig = typeof config;
