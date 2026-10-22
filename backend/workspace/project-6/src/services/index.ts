import { config } from '@/config';
import { request } from '@/lib/http';
import type { Repositories } from './repositories';
import { inMemoryRepositories } from './inMemory';
import { backendRepositories } from './backend';

/**
 * Resolves the active repository set based on configuration.
 * When no backend URL is set, we use a browser-local in-memory store
 * (persisted to localStorage) so the UI remains functional and data
 * survives reloads. When a backend is configured, we delegate to it.
 */
let current: Repositories | null = null;

export function getRepositories(): Repositories {
  if (current) return current;
  const resolved: Repositories = config.backendEnabled ? backendRepositories : inMemoryRepositories;
  current = resolved;
  return resolved;
}

/** Test-only: override the active repository set. Pass null to reset. */
export function setRepositoriesForTesting(repos: Repositories | null): void {
  current = repos;
}

/** Test whether the configured backend is reachable. Used by the health check. */
export async function pingBackend(): Promise<boolean> {
  if (!config.backendEnabled) return false;
  const { error } = await request<{ status: string }>('/health', { timeoutMs: 3000 });
  return !error;
}

export type { Repositories };
export { inMemoryRepositories, backendRepositories };
