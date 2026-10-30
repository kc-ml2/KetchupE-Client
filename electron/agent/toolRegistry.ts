import type { JsonSchemaType, JsonSchemaValidator } from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { AgentError, type ExternalDocumentRef } from "./contracts.ts";
import { McpConnection, sanitizeMcpResult } from "./mcp.ts";
import { withTimeout } from "./tools.ts";

export type ToolDescriptor = { id: string; description?: string; inputSchema: JsonSchemaType; outputSchema?: JsonSchemaType };
export type ToolExecutionResult = {
  /** Full execution data stays separate from the bounded model summary. */
  data: unknown;
  summary: string;
  documents?: ExternalDocumentRef[];
  excerpts?: Array<{ document: ExternalDocumentRef; text: string }>;
};
export type RegisteredTool = ToolDescriptor & {
  execute: (args: Record<string, unknown>, signal: AbortSignal) => Promise<ToolExecutionResult>;
};

/** Account-scoped, application-approved read-only tools. MCP annotations never grant execution permission. */
export class ToolRegistry {
  private readonly tools = new Map<string, { tool: RegisteredTool; input: JsonSchemaValidator<unknown>; output?: JsonSchemaValidator<unknown> }>();
  private readonly validator = new AjvJsonSchemaValidator();

  register(tool: RegisteredTool): void {
    if (!/^[\w.-]+\/[\w.-]+$/.test(tool.id) || this.tools.has(tool.id)) throw new Error(`duplicate or invalid tool: ${tool.id}`);
    this.tools.set(tool.id, {
      tool,
      input: this.validator.getValidator(tool.inputSchema),
      output: tool.outputSchema ? this.validator.getValidator(tool.outputSchema) : undefined,
    });
  }

  catalog(): ToolDescriptor[] {
    return [...this.tools.values()].map(({ tool: { id, description, inputSchema, outputSchema } }) =>
      structuredClone({ id, description, inputSchema, ...(outputSchema ? { outputSchema } : {}) }));
  }

  validateInput(id: string, args: Record<string, unknown>): void {
    const entry = this.tools.get(id);
    if (!entry) throw new AgentError("TOOL_UNAVAILABLE", "Tool is not registered");
    // Validator diagnostics may echo sensitive argument values.
    if (!entry.input(args).valid) throw new AgentError("INVALID_DECISION", "Tool arguments do not match the input schema");
  }

  async execute(id: string, args: Record<string, unknown>, signal: AbortSignal, timeoutMs: number): Promise<ToolExecutionResult> {
    if (signal.aborted) throw new AgentError("CANCELLED", "cancelled");
    this.validateInput(id, args);
    const entry = this.tools.get(id)!;
    const deadline = AbortSignal.timeout(timeoutMs);
    const executionSignal = AbortSignal.any([signal, deadline]);
    try {
      const result = await withTimeout(entry.tool.execute(args, executionSignal), timeoutMs, "TOOL_TIMEOUT", executionSignal);
      executionSignal.throwIfAborted();
      if (entry.output && !entry.output(result.data).valid) throw new AgentError("TOOL_UNAVAILABLE", "Tool returned invalid structured data");
      return result;
    } catch (error) {
      if (signal.aborted) throw new AgentError("CANCELLED", "cancelled");
      if (deadline.aborted) throw new AgentError("TOOL_TIMEOUT", "Tool timed out");
      throw error instanceof AgentError ? error : new AgentError("TOOL_UNAVAILABLE", "Tool call failed");
    }
  }

  /** The caller explicitly reviews this allowlist; discovered write tools remain unavailable. */
  async registerMcp(connection: McpConnection, approvedReadTools: readonly string[], signal: AbortSignal): Promise<void> {
    const tools = await connection.listTools(signal);
    const pending = new ToolRegistry();
    for (const tool of tools.filter((item) => approvedReadTools.includes(item.name))) {
      pending.register({
        id: `${connection.id}/${tool.name}`, description: tool.description,
        inputSchema: tool.inputSchema as JsonSchemaType, outputSchema: tool.outputSchema as JsonSchemaType | undefined,
        execute: async (args, callSignal) => {
          const result = await connection.callTool(tool.name, args, callSignal);
          if (result.isError) throw new AgentError("TOOL_UNAVAILABLE", "MCP tool returned an error");
          return {
            data: result.structuredContent ?? result.content,
            summary: JSON.stringify(sanitizeMcpResult(result.structuredContent ?? result.content)),
          };
        },
      });
    }
    // A malformed schema must not leave half of a connection's catalog installed.
    for (const id of pending.tools.keys()) if (this.tools.has(id)) throw new Error(`duplicate tool: ${id}`);
    for (const [id, entry] of pending.tools) this.tools.set(id, entry);
  }
}
