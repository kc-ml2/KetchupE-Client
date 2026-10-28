import { z } from "zod";
import type { JsonSchemaType } from "@modelcontextprotocol/client";
import type { PolicyDecision } from "./contracts.ts";
import { AgentError } from "./contracts.ts";
import { browseStorageArguments, findStorageArguments } from "./maruToolSchemas.ts";
import { ToolRegistry } from "./toolRegistry.ts";
import type { SearchTools } from "./tools.ts";

/** Keep provider semantics at registration; the Harness executes every lookup through one contract. */
export function registerDiscoveryTools(registry: ToolRegistry, tools: SearchTools): void {
  if (tools.maru) {
    const maru = tools.maru;
    const definitions = [
      { name: "browse_storage", schema: browseStorageArguments, description: "List accessible shared document storages and browse their folders. Use for requests such as 'show shared folders' without needing a provider name. Empty arguments list storages; use returned storage_id values to browse. Never infer storage IDs." },
      { name: "find_storage", schema: findStorageArguments, description: "Find shared files by literal keyword, filename, date or size. Requires query or storage_id plus file_path. Resolve storage names with maru/browse_storage first. Returned ref_id can be used with read_external_document for citable contents. Preserve truncation and unsearched statuses; never expose download URLs." },
    ] as const;
    for (const { name, schema, description } of definitions) {
      registry.register({
        id: `maru/${name}`, description, inputSchema: z.toJSONSchema(schema) as JsonSchemaType,
        execute: async (args, signal) => {
          if (name === "find_storage") {
            const input = findStorageArguments.parse(args);
            if ((!input.query?.trim() && !(input.storage_id?.trim() && input.file_path?.trim())) ||
              (input.min_size_bytes != null && input.max_size_bytes != null && input.min_size_bytes > input.max_size_bytes)) {
              throw new AgentError("INVALID_DECISION", "File search requires a query or exact file, and a valid size range");
            }
          }
          const result = await maru.call(name, args, signal);
          return { ...result, data: result.data ?? result.summary };
        },
      });
    }
  }
  if (tools.trolley) {
    const trolley = tools.trolley;
    for (const name of ["get_my_capabilities", "list_operations"] as const) {
      registry.register({
        id: `trolley/${name}`,
        description: name === "get_my_capabilities"
          ? "Discover the current user's access to connected business operations. Use when asked what business operations they can access; no provider name is needed. Does not execute operations."
          : "List available business operations and their inputs after checking current access. Use when asked which automated business tasks are available. Discovery only: cannot execute operations. An empty list does not prove a lack of administrator access.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: async (_args, signal) => {
          const result = await trolley.call(name, signal);
          return { ...result, data: result.data ?? result.summary };
        },
      });
    }
  }
}

/** Legacy decisions remain readable for waiting runs and existing evaluation fixtures. */
export function discoveryCall(search: NonNullable<PolicyDecision["search"]>): { toolId: string; arguments: Record<string, unknown> } | undefined {
  switch (search.tool) {
    case "call_tool": return search;
    case "browse_storage":
    case "find_storage": return { toolId: `maru/${search.tool}`, arguments: search.arguments ?? {} };
    case "get_my_capabilities":
    case "list_operations": return { toolId: `trolley/${search.tool}`, arguments: {} };
    default: return undefined;
  }
}
