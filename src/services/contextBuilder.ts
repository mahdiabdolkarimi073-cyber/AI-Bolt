import type { AgentMessage, AgentSystemPrompt } from '@/types/agent';

/**
 * Conversation context construction.
 *
 * Builds the ordered message list passed to a provider adapter:
 *   [system?] [history...] [current user message]
 *
 * Deterministic and independently testable. No embeddings, no vector store,
 * no semantic retrieval (Phase 5 scope). Truncation is character-based and
 * honestly reported as an approximation when no real token counter exists.
 */

export interface BuiltContext {
  messages: AgentMessage[];
  /** True when the context was truncated to fit a limit. */
  truncated: boolean;
  /** Number of history messages dropped from the front (oldest first). */
  droppedHistoryCount: number;
  /** "token" if a real token counter was used, "chars" if character-based. */
  limitKind: 'token' | 'chars' | 'none';
  /** Effective limit value applied, if any. */
  limitValue?: number;
}

export interface BuildContextOptions {
  /** System instructions, if any. */
  system?: AgentSystemPrompt;
  /** Prior conversation messages, oldest first. MUST NOT include the current
   *  user message — the caller passes that separately to prevent duplication. */
  history: AgentMessage[];
  /** The current user message, already persisted (with id + timestamp). */
  currentMessage: AgentMessage;
  /** Soft character limit for the whole context (excluding system). 0 = none. */
  maxContextChars?: number;
  /** Max number of history messages to include. 0 = unlimited. */
  maxHistoryMessages?: number;
}

const DEFAULT_SYSTEM: AgentSystemPrompt = {
  content:
    'You are a helpful assistant inside a personal AI IDE. Be concise and accurate.',
  source: 'default',
};

/**
 * Build the agent context.
 *
 * Truncation strategy (character-budget, approximation of token count):
 *   1. Always include the system prompt (if any) — never dropped.
 *   2. Always include the current user message — never dropped or truncated.
 *   3. Include as many recent history messages as fit the remaining budget,
 *      dropping the oldest first. This preserves the most relevant recent
 *      context and never silently truncates the latest user message.
 */
export function buildContext(opts: BuildContextOptions): BuiltContext {
  const system = opts.system ?? DEFAULT_SYSTEM;
  const current = opts.currentMessage;
  const maxChars = opts.maxContextChars ?? 0;
  const maxMsgs = opts.maxHistoryMessages ?? 0;
  const limitKind: 'token' | 'chars' | 'none' =
    maxChars > 0 ? 'chars' : 'none';

  // Cap history count first.
  let history = opts.history.slice();
  if (maxMsgs > 0 && history.length > maxMsgs) {
    history = history.slice(history.length - maxMsgs);
  }

  // If no character budget, the context is trivially: [system?] [history] [current].
  if (maxChars <= 0) {
    const messages = withSystem(system, [...history, current]);
    return {
      messages,
      truncated: false,
      droppedHistoryCount: opts.history.length - history.length,
      limitKind,
    };
  }

  // Reserve budget for system + current; spend the rest on recent history.
  const systemLen = system.content.length;
  const currentLen = current.content.length;
  const remaining = Math.max(0, maxChars - systemLen - currentLen);

  let droppedByChars = 0;
  let used = 0;
  const kept: AgentMessage[] = [];
  // Walk history from newest to oldest, keeping until budget exhausted.
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    const cost = m.content.length + 1; // +1 for separator/role overhead
    if (used + cost > remaining) break;
    kept.unshift(m);
    used += cost;
    droppedByChars = history.length - kept.length;
  }

  const truncated = droppedByChars > 0 || opts.history.length > kept.length;
  const droppedHistoryCount = opts.history.length - kept.length;
  const messages = withSystem(system, [...kept, current]);

  return {
    messages,
    truncated,
    droppedHistoryCount,
    limitKind,
    limitValue: maxChars,
  };
}

function withSystem(system: AgentSystemPrompt, rest: AgentMessage[]): AgentMessage[] {
  const sysMsg: AgentMessage = {
    id: 'system',
    role: 'system',
    content: system.content,
    createdAt: 0,
  };
  return [sysMsg, ...rest];
}

/** Estimate a rough character budget from a desired message count. Used by
 *  the runtime when only a message-count limit is configured. Honestly
 *  reported as a `chars` approximation by buildContext. */
export function approximateCharBudget(
  history: AgentMessage[],
  maxMessages: number,
  avgCharsPerMessage = 500,
): number {
  const sample = history.slice(Math.max(0, history.length - maxMessages));
  if (sample.length === 0) return maxMessages * avgCharsPerMessage;
  const total = sample.reduce((s, m) => s + m.content.length, 0);
  return Math.max(total, maxMessages * avgCharsPerMessage);
}
