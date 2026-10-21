import { AgentError } from "./contracts.ts";
import { McpConnection, sanitizeMcpResult } from "./mcp.ts";
import type { ExternalCallResult } from "./tools.ts";

export const DEFAULT_TROLLEY_ENDPOINT = new URL("https://trolley.ml2-alpha.com/mcp/");
export const TROLLEY_DISCOVERY_TOOLS = ["get_my_capabilities", "list_operations"] as const;
export type TrolleyDiscoveryTool = (typeof TROLLEY_DISCOVERY_TOOLS)[number];

/** Bearer API-key connection; this adapter exposes discovery, not Operation execution. */
export class TrolleyClient {
  private readonly connection: McpConnection;

  constructor(apiKey: string, appVersion: string, endpoint = DEFAULT_TROLLEY_ENDPOINT) {
    this.connection = new McpConnection({
      id: "trolley", endpoint, clientName: "ketchupe", clientVersion: appVersion,
      token: async () => apiKey,
      allowedTools: TROLLEY_DISCOVERY_TOOLS,
    });
  }

  async call(tool: TrolleyDiscoveryTool, signal: AbortSignal): Promise<ExternalCallResult> {
    if (!TROLLEY_DISCOVERY_TOOLS.includes(tool)) throw new AgentError("TOOL_UNAVAILABLE", "Trolley tool is not allowed");
    const capabilities = await this.read("get_my_capabilities", signal);
    const payload = tool === "get_my_capabilities" ? capabilities
      : { capabilities, operations: await this.read("list_operations", signal) };
    return { summary: JSON.stringify(sanitizeMcpResult(payload)), documents: [] };
  }

  close(): Promise<void> {
    return this.connection.close();
  }

  private async read(tool: TrolleyDiscoveryTool, signal: AbortSignal): Promise<unknown> {
    const result = await this.connection.callTool(tool, {}, signal);
    if (result.isError) throw new AgentError("TOOL_UNAVAILABLE", `Trolley ${tool} returned an error`);
    if (result.structuredContent !== undefined) return result.structuredContent;
    const text = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    if (!text) throw new AgentError("TOOL_UNAVAILABLE", `Trolley ${tool} returned no data`);
    try { return JSON.parse(text); } catch { throw new AgentError("TOOL_UNAVAILABLE", `Trolley ${tool} returned invalid JSON`); }
  }
}
