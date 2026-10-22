import type { ProviderId } from '@/types';
import type { AIProvider } from './providers/aiProvider';
import { StubProvider, stubProviders } from './providers/stubProvider';
import { DevProvider } from './providers/devProvider';
import { AgentRuntime, type AgentRuntimeOptions } from './agentRuntime';
import { getRepositories } from './index';
import { DEFAULT_RETRIEVAL_BUDGET_CHARS } from './retrieval';

/**
 * Wire the Agent runtime to the existing service layer.
 *
 * The provider resolver returns stub adapters for every real provider id in
 * Phase 5 (real integrations arrive in Phase 6). A shared DevProvider is used
 * when a request explicitly allows simulation.
 */

let runtimeSingleton: AgentRuntime | null = null;
let devProviderSingleton: DevProvider | null = null;

/** Get the shared DevProvider instance (for tests / UI simulation toggle). */
export function getDevProvider(): DevProvider {
  if (!devProviderSingleton) devProviderSingleton = new DevProvider();
  return devProviderSingleton;
}

/** Resolve a provider adapter by id. Phase 5: all real providers are stubs. */
export function resolveProvider(id: ProviderId): AIProvider {
  const factory = stubProviders[id];
  return factory ? factory() : new StubProvider(id, String(id));
}

/** Build a fresh runtime (used by tests). */
export function createRuntime(opts?: Partial<AgentRuntimeOptions>): AgentRuntime {
  return new AgentRuntime({
    repositories: opts?.repositories ?? getRepositories(),
    resolveProvider: opts?.resolveProvider ?? ((id: ProviderId) => resolveProvider(id)),
    devProvider: opts?.devProvider ?? getDevProvider(),
    defaultSystemPrompt:
      opts?.defaultSystemPrompt ??
      'You are a helpful assistant inside a personal AI IDE. Be concise and accurate.',
    defaultMaxContextChars: opts?.defaultMaxContextChars ?? 24_000,
    defaultMaxHistoryMessages: opts?.defaultMaxHistoryMessages ?? 20,
    defaultTimeoutMs: opts?.defaultTimeoutMs ?? 30_000,
    defaultMaxRetrievalChars: opts?.defaultMaxRetrievalChars ?? DEFAULT_RETRIEVAL_BUDGET_CHARS,
  });
}

/** Get the shared runtime singleton. */
export function getAgentRuntime(): AgentRuntime {
  if (!runtimeSingleton) runtimeSingleton = createRuntime();
  return runtimeSingleton;
}

export { AgentRuntime };
export type { AgentRuntimeOptions };
