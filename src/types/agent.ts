// Agent domain contracts for Phase 5.
//
// These types describe the Agent execution layer: the request that enters the
// runtime, the structured response that comes out, the lifecycle states a run
// moves through, and the future tool-calling contracts. They are intentionally
// provider-neutral — vendor-specific shapes live only inside provider adapters.
//
// Reuse existing domain types where shapes overlap (e.g. ConversationMessage)
// instead of duplicating representations.

import type { ProviderId } from '@/types';
import type { ApiError } from './domain';

/** Message roles understood by the Agent core. `tool` is reserved for future
 *  tool-call/result support and is accepted by the runtime but not produced in
 *  Phase 5 text-only conversations. */
export type AgentRole = 'system' | 'user' | 'assistant' | 'tool';

/** A single message in the agent context window. Stable id, role, content,
 *  and timestamp. `tool` messages additionally carry toolCallId / toolName. */
export interface AgentMessage {
  id: string;
  role: AgentRole;
  content: string;
  createdAt: number;
  /** Present only for role === 'tool' (future). */
  toolCallId?: string;
  toolName?: string;
  /** True when the content was produced by the development/test provider and
   *  must NOT be presented as a real model response. */
  simulated?: boolean;
}

/** System instructions supplied per-run. The runtime must NOT trust
 *  client-supplied privileged instructions; callers can override the default
 *  user-facing instructions but cannot inject backend/system-privileged
 *  directives through this field in backend mode. */
export interface AgentSystemPrompt {
  content: string;
  /** Whether this prompt came from the user (UI) or the system default. */
  source: 'default' | 'user';
}

/** Configuration carried by an Agent request. */
export interface AgentConfig {
  providerId: ProviderId;
  model: string;
  /** Soft character limit for context construction. When no reliable token
   *  counter is available, this is an approximation and must be reported as
   *  such. 0 = no limit. */
  maxContextChars?: number;
  /** Maximum number of prior messages to include in context. 0 = unlimited. */
  maxHistoryMessages?: number;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Optional user-supplied system instructions. */
  systemPrompt?: string;
  /** When true, allow the deterministic development provider to answer.
   *  Never silently enabled as a production fallback. */
  allowSimulation?: boolean;
}

/** A validated request entering the Agent runtime. */
export interface AgentRequest {
  conversationId: string;
  message: string;
  config: AgentConfig;
  signal?: AbortSignal;
  /** Client-generated idempotency key to prevent duplicate submissions of the
   *  same user input within a short window. */
  requestId: string;
}

/** Provider execution metadata returned by the adapter. Fields are optional
 *  because providers differ — never invent values the provider did not return. */
export interface ProviderExecutionMeta {
  providerId: ProviderId | 'dev';
  model?: string;
  /** True if the response came from a development/test/simulated provider. */
  simulated?: boolean;
  /** Token usage when the provider reports it. Do not fabricate. */
  usage?: TokenUsage;
  /** Provider-reported finish reason, when available. */
  finishReason?: string;
}

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/** Run status lifecycle. */
export type RunStatus =
  | 'pending'
  | 'running'
  | 'provider_in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** A structured Agent error, safe to display. Never includes stack traces,
 *  credentials, or sensitive request data. */
export interface AgentError {
  code: AgentErrorCode;
  message: string;
  /** Underlying cause code (e.g. ApiError.code) for diagnostics, sanitized. */
  causeCode?: string;
}

export type AgentErrorCode =
  | 'invalid_request'
  | 'provider_not_ready'
  | 'provider_unavailable'
  | 'provider_failed'
  | 'timeout'
  | 'cancelled'
  | 'persistence_failed'
  | 'unsupported_tool_call'
  | 'duplicate_submission'
  | 'unknown';

/** The structured result of an Agent run. */
export interface AgentResult {
  requestId: string;
  conversationId: string;
  status: RunStatus;
  /** The persisted user message, when saved. */
  userMessage?: AgentMessage;
  /** The persisted assistant message, when the run completed. */
  assistantMessage?: AgentMessage;
  /** Present when status === 'failed'. */
  error?: AgentError;
  /** Provider execution metadata, when a provider actually ran. */
  meta?: ProviderExecutionMeta;
  /** Lifecycle timestamps (ms epoch). */
  startedAt: number;
  finishedAt?: number;
}

// --- Future tool-calling contracts (Phase 5: abstraction only, no execution) ---

/** A tool definition registered with the runtime. Execution is NOT performed
 *  in this phase; the contract exists so later phases can add tools without
 *  rewriting the core. */
export interface AgentTool {
  id: string;
  description: string;
  /** JSON-Schema-like input schema (kept minimal/lightweight). */
  inputSchema: ToolInputSchema;
  /** Permission level required to invoke this tool. */
  permission: ToolPermission;
}

export interface ToolInputSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
}

export type ToolPermission = 'read' | 'write' | 'execute';

/** A tool call requested by a model. */
export interface ToolCall {
  id: string;
  toolId: string;
  input: unknown;
}

/** Result of a tool invocation. In Phase 5, only `unsupported` is produced. */
export interface ToolResult {
  callId: string;
  toolId: string;
  status: 'success' | 'failed' | 'unsupported';
  output?: string;
  error?: AgentError;
}

/** Convert an ApiError-shaped value (loose, string code) to a typed AgentError. */
export function apiErrorToAgentError(err: { code: string; message: string }): AgentError {
  return { code: mapApiCode(err.code), message: sanitize(err.message), causeCode: err.code };
}

/** Converts an ApiError-shaped value to a safe AgentError. */
export function toAgentError(
  err: unknown,
  fallbackCode: AgentErrorCode = 'unknown',
): AgentError {
  if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
    const e = err as ApiError;
    const code = mapApiCode(e.code);
    return { code, message: sanitize(e.message), causeCode: e.code };
  }
  if (err instanceof Error) {
    return { code: fallbackCode, message: sanitize(err.message) };
  }
  return { code: fallbackCode, message: 'An unexpected error occurred.' };
}

function mapApiCode(code: string): AgentErrorCode {
  switch (code) {
    case 'timeout':
      return 'timeout';
    case 'network':
    case 'backend_unavailable':
      return 'provider_unavailable';
    case 'forbidden':
    case 'not_found':
      return 'provider_unavailable';
    case 'validation':
      return 'invalid_request';
    default:
      return 'unknown';
  }
}

/** Remove anything that looks like a secret or stack trace from a message. */
function sanitize(msg: string): string {
  if (typeof msg !== 'string') return 'An unexpected error occurred.';
  // Strip common secret patterns and file paths from stack traces.
  return msg
    .replace(/(sk-[A-Za-z0-9-_]{10,})/g, '[redacted]')
    .replace(/(AIza[A-Za-z0-9-_]{20,})/g, '[redacted]')
    .split('\n')[0]
    .slice(0, 500);
}
