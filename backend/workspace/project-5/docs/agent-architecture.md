# Agent Architecture (Phase 5)

## Overview

Phase 5 introduces the Agent execution layer: a provider-neutral, deterministic
runtime that orchestrates conversation context, provider calls, and message
persistence. Real AI provider integrations (Gemini, Groq, Cerebras, OpenRouter)
ship in Phase 6 — the contracts and infrastructure defined here are designed so
those adapters slot in without rewriting the core.

## Core Components

### 1. Agent Domain Contracts (`src/types/agent.ts`)

Typed contracts for the entire Agent layer:

- **`AgentRequest`** — validated input: conversation id, message, config, abort signal, idempotency key.
- **`AgentResult`** — structured output: status, persisted user/assistant messages, error, provider metadata.
- **`AgentError`** — safe-to-display error with typed codes (`provider_not_ready`, `timeout`, `cancelled`, `duplicate_submission`, `unsupported_tool_call`, etc.). Never includes stack traces or secrets.
- **`RunStatus`** — lifecycle: `pending → running → provider_in_progress → completed | failed | cancelled`.
- **`AgentTool` / `ToolCall` / `ToolResult`** — future tool-calling contracts (abstraction only, no execution in Phase 5).

### 2. Provider Interface (`src/services/providers/aiProvider.ts`)

The `AIProvider` interface is the single contract every provider adapter
implements:

- **`isReady()`** — whether the provider can serve requests (has key + enabled).
- **`capabilities()`** — declared models, streaming support, tool-call support, simulated flag.
- **`execute(req)`** — structured (non-streaming) execution returning content + metadata.
- **`stream(req)`** — streaming chat completion (legacy compatibility).

**Adapters:**

| Adapter | File | Purpose |
|---------|------|---------|
| `StubProvider` | `stubProvider.ts` | Safe no-op for real providers not yet wired. Reports `isReady() = false`. |
| `DevProvider` | `devProvider.ts` | Deterministic development/test provider. Clearly marked as simulated. Never contacts a real API. |

The `DevProvider` is **explicitly a simulation** — it is never a silent
production fallback. It is only selected when `config.allowSimulation === true`.
All simulated responses carry `simulated: true` in metadata so the UI and logs
can distinguish them from real model responses.

### 3. Context Builder (`src/services/contextBuilder.ts`)

Deterministic, independently testable context construction:

```
[system?] [history...] [current user message]
```

- The system prompt is always included (never dropped).
- The current user message is always included (never dropped or truncated).
- History is truncated oldest-first when a character budget is exceeded.
- Truncation is honestly reported as character-based approximation (`limitKind: 'chars'`) when no real token counter exists.

### 4. Agent Runtime (`src/services/agentRuntime.ts`)

The orchestration core. Responsibilities:

1. **Validate** the request (non-empty message, valid conversation id, valid model).
2. **Reject duplicates** via idempotency keys and per-conversation overlap detection.
3. **Resolve the provider** through the provider abstraction.
4. **Check readiness** — returns a clear `provider_not_ready` error if no adapter is ready.
5. **Validate the model** against declared capabilities.
6. **Persist the user message** first (authoritative path).
7. **Load history** from the persistence layer.
8. **Build context** via the context builder.
9. **Execute** through the provider, with timeout and cancellation support.
10. **Handle tool calls** — returns `unsupported_tool_call` (Phase 5 does not execute tools).
11. **Persist the assistant message** (authoritative path).
12. **Return** a structured `AgentResult`.

**Persistence ownership:** The runtime is the SINGLE authoritative persistence
path. The UI does NOT independently save messages — it reads them back from the
repository after each run. This prevents double-save bugs.

**Cancellation:** Supported via `AbortSignal`. The runtime propagates abort to
the provider and returns a `cancelled` status.

### 5. Tool Abstraction (`src/services/tools.ts`)

- `ToolRegistry` — register, list, and validate tools.
- `unsupportedToolResult()` — the ONLY outcome for tool calls in Phase 5.
- No tool execution is performed. The contract exists so Phase 7+ can add tools
  (file read, error inspection, code edit, terminal) without rewriting the core.

## Backend Agent Route (`backend/app/agent_routes.py`)

`POST /agent/run`:

- Validates conversation id, message, and request size.
- Uses the same `MessageRepo` persistence path as other backend routes.
- Supports `allowSimulation` for deterministic local testing.
- When a provider API key is configured in `backend/.env` but the real
  integration isn't wired yet (Phase 5), returns a clear message.
- Never leaks secrets or internal exception details.

## Frontend Integration

- **`useAgentChat` hook** (`src/hooks/useAgentChat.ts`) — bridges the runtime to
  React. In backend mode delegates to `POST /agent/run`; in fallback mode runs
  the local `AgentRuntime` with the `DevProvider`.
- **`AppShell`** — lazily creates a conversation on first send, wires the hook
  to `AIChatPanel`, and tracks simulated message ids for UI badges.
- **`AIChatPanel` / `ChatMessage`** — show a "Simulated" badge on assistant
  messages from the DevProvider, and surface errors inline.

## Testing

Automated tests with Vitest (32 tests, all passing):

| File | Tests | Coverage |
|------|-------|----------|
| `contextBuilder.test.ts` | 7 | Ordering, truncation, system prompt, budget |
| `devProvider.test.ts` | 8 | Readiness, deterministic output, failure injection, cancellation, streaming |
| `agentRuntime.test.ts` | 10 | Full lifecycle, persistence, duplicates, overlap, cancellation, model validation |
| `tools.test.ts` | 7 | Registry, validation, unsupported results |

Run with: `npm test`

## Design Principles

1. **Provider neutrality** — no vendor SDK types leak into the Agent core.
2. **Deterministic testing** — the DevProvider makes every code path testable without network or API keys.
3. **Single persistence path** — the runtime owns message persistence; the UI never duplicates it.
4. **Explicit simulation** — simulated responses are always marked, never masqueraded as real.
5. **Safe errors** — `AgentError` strips secrets and stack traces before surfacing.
6. **Future-ready** — tool contracts exist today; execution arrives in a later phase without core changes.
