import type {
  AgentTool,
  ToolCall,
  ToolResult,
  ToolPermission,
  ToolInputSchema,
} from '@/types/agent';

/**
 * Tool abstraction for future Agent capabilities.
 *
 * Phase 5 defines the contracts ONLY. No tool execution is performed. If a
 * model requests a tool call, the runtime returns a clear
 * `unsupported_tool_call` result and terminates the run safely.
 *
 * The registry exists so Phase 7+ can register concrete tools (file read,
 * error inspection, code edit, terminal) without rewriting the core runtime.
 */

export interface ToolRegistry {
  register(tool: AgentTool): void;
  list(): AgentTool[];
  get(id: string): AgentTool | null;
  /** Validate input against a tool's schema. Does NOT execute. */
  validateInput(toolId: string, input: unknown): ToolValidation;
  /** Execute is intentionally absent in Phase 5. Tools cannot run. */
}

export interface ToolValidation {
  ok: boolean;
  errors: string[];
}

export class InMemoryToolRegistry implements ToolRegistry {
  private tools = new Map<string, AgentTool>();

  register(tool: AgentTool): void {
    this.tools.set(tool.id, tool);
  }

  list(): AgentTool[] {
    return Array.from(this.tools.values());
  }

  get(id: string): AgentTool | null {
    return this.tools.get(id) ?? null;
  }

  validateInput(toolId: string, input: unknown): ToolValidation {
    const tool = this.get(toolId);
    if (!tool) return { ok: false, errors: [`Unknown tool: ${toolId}`] };
    return validateAgainstSchema(input, tool.inputSchema);
  }
}

/** Minimal JSON-Schema-like validation (object + required keys + types). */
export function validateAgainstSchema(
  input: unknown,
  schema: ToolInputSchema,
): ToolValidation {
  const errors: string[] = [];
  if (schema.type === 'object') {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return { ok: false, errors: ['Expected an object.'] };
    }
    const obj = input as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj) || obj[key] === undefined) {
        errors.push(`Missing required field: ${key}`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Produce an unsupported-tool-call result. This is the ONLY outcome the
 * runtime can produce for a tool call in Phase 5.
 */
export function unsupportedToolResult(call: ToolCall): ToolResult {
  return {
    callId: call.id,
    toolId: call.toolId,
    status: 'unsupported',
    error: {
      code: 'unsupported_tool_call',
      message:
        'Tool execution is not enabled in this phase. The Agent received a tool request but cannot execute it.',
    },
  };
}

/** Build an empty registry. Phase 5 ships with no registered tools. */
export function createToolRegistry(): ToolRegistry {
  return new InMemoryToolRegistry();
}

export type { ToolPermission };
