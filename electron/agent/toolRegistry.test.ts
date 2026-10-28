// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentError } from "./contracts.ts";
import { McpConnection } from "./mcp.ts";
import { ToolRegistry } from "./toolRegistry.ts";

afterEach(() => vi.restoreAllMocks());
const signal = () => new AbortController().signal;
const inputSchema = { type: "object" as const, properties: { query: { type: "string" as const } }, required: ["query"], additionalProperties: false };

describe("ToolRegistry", () => {
  it("registers a third MCP provider by schema and explicit allowlist, keeping full data separate from context", async () => {
    const connection = new McpConnection({ id: "catalog", endpoint: new URL("https://catalog.test/mcp"), clientName: "test", clientVersion: "test" });
    vi.spyOn(connection, "listTools").mockResolvedValue([
      { name: "find_products", description: "Find products by name", inputSchema },
      { name: "delete_product", description: "Delete a product", inputSchema, annotations: { readOnlyHint: true } },
    ]);
    const data = { products: Array.from({ length: 30 }, (_, id) => ({ id })), token: "private-token" };
    const call = vi.spyOn(connection, "callTool").mockResolvedValue({ content: [], structuredContent: data });
    const registry = new ToolRegistry();
    await registry.registerMcp(connection, ["find_products"], signal());
    expect(registry.catalog().map((tool) => tool.id)).toEqual(["catalog/find_products"]);
    const result = await registry.execute("catalog/find_products", { query: "pump" }, signal(), 1000);
    expect(result.data).toEqual(data);
    expect(result.summary).not.toContain("private-token");
    expect(result.summary).toContain("omitted_items");
    await expect(registry.execute("catalog/delete_product", { query: "pump" }, signal(), 1000)).rejects.toMatchObject({ code: "TOOL_UNAVAILABLE" });
    await expect(registry.execute("catalog/find_products", { query: 1 }, signal(), 1000)).rejects.toMatchObject({ code: "INVALID_DECISION" });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate registrations, invalid outputs and unknown arguments", async () => {
    const registry = new ToolRegistry();
    const execute = vi.fn(async () => ({ data: { count: "wrong" }, summary: "invalid" }));
    const definition = { id: "local/count", inputSchema, outputSchema: { type: "object" as const, properties: { count: { type: "integer" as const } }, required: ["count"] }, execute };
    registry.register(definition);
    expect(() => registry.register(definition)).toThrow("duplicate");
    await expect(registry.execute(definition.id, { query: "x", userId: "invented" }, signal(), 1000)).rejects.toMatchObject({ code: "INVALID_DECISION" });
    expect(execute).not.toHaveBeenCalled();
    await expect(registry.execute(definition.id, { query: "x" }, signal(), 1000)).rejects.toMatchObject({ code: "TOOL_UNAVAILABLE" });
  });

  it("aborts timed out work, rejects late results, and distinguishes cancellation", async () => {
    const registry = new ToolRegistry();
    let executionSignal: AbortSignal | undefined;
    registry.register({ id: "local/slow", inputSchema, execute: async (_args, callSignal) => {
      executionSignal = callSignal;
      return new Promise(() => undefined);
    } });
    await expect(registry.execute("local/slow", { query: "x" }, signal(), 10)).rejects.toMatchObject({ code: "TOOL_TIMEOUT" });
    expect(executionSignal?.aborted).toBe(true);
    const controller = new AbortController();
    const pending = registry.execute("local/slow", { query: "x" }, controller.signal, 1000);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("never retries an error or exposes a remote error body", async () => {
    const connection = new McpConnection({ id: "catalog", endpoint: new URL("https://catalog.test/mcp"), clientName: "test", clientVersion: "test" });
    vi.spyOn(connection, "listTools").mockResolvedValue([{ name: "find", inputSchema }]);
    const call = vi.spyOn(connection, "callTool").mockResolvedValue({ isError: true, content: [{ type: "text", text: "private diagnostic" }] });
    const registry = new ToolRegistry();
    await registry.registerMcp(connection, ["find"], signal());
    await expect(registry.execute("catalog/find", { query: "x" }, signal(), 1000)).rejects.toEqual(new AgentError("TOOL_UNAVAILABLE", "MCP tool returned an error"));
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("does not partially install a connection when an output schema cannot compile", async () => {
    const connection = new McpConnection({ id: "catalog", endpoint: new URL("https://catalog.test/mcp"), clientName: "test", clientVersion: "test" });
    vi.spyOn(connection, "listTools").mockResolvedValue([
      { name: "valid", inputSchema },
      { name: "invalid", inputSchema, outputSchema: { type: "object", properties: { result: { $ref: "#/missing" } } } },
    ]);
    const registry = new ToolRegistry();
    await expect(registry.registerMcp(connection, ["valid", "invalid"], signal())).rejects.toThrow();
    expect(registry.catalog()).toEqual([]);
  });
});
