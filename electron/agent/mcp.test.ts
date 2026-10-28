// @vitest-environment node
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, expect, it, vi } from "vitest";
import { McpConnection } from "./mcp.ts";

afterEach(() => vi.restoreAllMocks());

it("discovers every tool page and exposes only allowed tools", async () => {
  vi.spyOn(Client.prototype, "connect").mockResolvedValue();
  vi.spyOn(Client.prototype, "close").mockResolvedValue();
  vi.spyOn(StreamableHTTPClientTransport.prototype, "terminateSession").mockResolvedValue();
  const list = vi.spyOn(Client.prototype, "listTools")
    .mockResolvedValueOnce({ tools: [{ name: "write", inputSchema: { type: "object" } }], nextCursor: "second" })
    .mockResolvedValueOnce({ tools: [{ name: "find", inputSchema: { type: "object" } }] });
  const call = vi.spyOn(Client.prototype, "callTool").mockResolvedValue({ content: [] });
  const connection = new McpConnection({ id: "test", endpoint: new URL("https://test.invalid/mcp"), clientName: "test", clientVersion: "test", allowedTools: ["find"] });
  const signal = new AbortController().signal;
  expect((await connection.listTools(signal)).map((tool) => tool.name)).toEqual(["find"]);
  expect(list).toHaveBeenNthCalledWith(2, { cursor: "second" }, { signal, cacheMode: "refresh" });
  await connection.callTool("find", {}, signal);
  await expect(connection.callTool("write", {}, signal)).rejects.toMatchObject({ code: "TOOL_UNAVAILABLE" });
  expect(call).toHaveBeenCalledTimes(1);
  await connection.close();
});

it("rejects repeated pagination cursors instead of hanging", async () => {
  vi.spyOn(Client.prototype, "connect").mockResolvedValue();
  vi.spyOn(Client.prototype, "close").mockResolvedValue();
  vi.spyOn(Client.prototype, "listTools").mockResolvedValue({ tools: [], nextCursor: "same" });
  const connection = new McpConnection({ id: "test", endpoint: new URL("https://test.invalid/mcp"), clientName: "test", clientVersion: "test" });
  await expect(connection.listTools(new AbortController().signal)).rejects.toMatchObject({ code: "TOOL_UNAVAILABLE" });
});
