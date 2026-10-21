// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpConnection, sanitizeMcpResult } from "./mcp.ts";
import { TrolleyClient, type TrolleyDiscoveryTool } from "./trolley.ts";

afterEach(() => vi.restoreAllMocks());

describe("Trolley discovery", () => {
  it("marks bounded Operation lists as incomplete", () => {
    const result = sanitizeMcpResult(Array.from({ length: 25 }, (_, index) => ({ name: `op-${index}` }))) as unknown[];
    expect(result).toHaveLength(21);
    expect(result.at(-1)).toEqual({ omitted_items: 5 });
  });

  it("checks capabilities before listing Operations and omits secrets and URLs", async () => {
    const call = vi.spyOn(McpConnection.prototype, "callTool")
      .mockResolvedValueOnce({ content: [], structuredContent: { role: "developer", api_key: "synthetic-secret" } })
      .mockResolvedValueOnce({ content: [{ type: "text", text: JSON.stringify([{ name: "report", input_schema: {}, url: "https://trolley.test/file?token=synthetic" }]) }] });
    const client = new TrolleyClient("synthetic", "test");
    const signal = new AbortController().signal;
    const result = await client.call("list_operations", signal);
    expect(call.mock.calls.map(([name]) => name)).toEqual(["get_my_capabilities", "list_operations"]);
    expect(call).toHaveBeenNthCalledWith(1, "get_my_capabilities", {}, signal);
    expect(JSON.parse(result.summary)).toEqual({ capabilities: { role: "developer" }, operations: [{ name: "report", input_schema: {} }] });
    expect(result.documents).toEqual([]);
  });

  it("does not list Operations when capabilities are denied, nor expose raw error data", async () => {
    const call = vi.spyOn(McpConnection.prototype, "callTool").mockResolvedValue({ isError: true, content: [{ type: "text", text: "secret diagnostic" }] });
    await expect(new TrolleyClient("synthetic", "test").call("list_operations", new AbortController().signal)).rejects.toMatchObject({ code: "TOOL_UNAVAILABLE", message: "Trolley get_my_capabilities returned an error" });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("rejects execution tools and malformed responses", async () => {
    const call = vi.spyOn(McpConnection.prototype, "callTool").mockResolvedValue({ content: [{ type: "text", text: "not JSON" }] });
    const client = new TrolleyClient("synthetic", "test");
    await expect(client.call("execute" as TrolleyDiscoveryTool, new AbortController().signal)).rejects.toMatchObject({ code: "TOOL_UNAVAILABLE" });
    expect(call).not.toHaveBeenCalled();
    await expect(client.call("get_my_capabilities", new AbortController().signal)).rejects.toThrow("invalid JSON");
  });
});
