import { createHash } from "node:crypto";
import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { extname, join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { z } from "zod";
import type { IngestedSource } from "../tomato/tomato.ts";
import type { TomatoClient } from "../tomato/tomatoClient.ts";
import { AgentError, type ExternalDocumentRef } from "./contracts.ts";
import { McpConnection, sanitizeMcpResult as sanitizeMaruResult } from "./mcp.ts";
export { sanitizeMcpResult as sanitizeMaruResult } from "./mcp.ts";
import type { ExternalCallResult } from "./tools.ts";

export const DEFAULT_MARU_ENDPOINT = new URL("https://maru.ml2-alpha.com/mcp");
const MARU_TOOLS = ["browse_storage", "find_storage"] as const;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_SAFE_RESULTS = 12;

const matchSchema = z.object({
  line: z.number().int().optional(),
  byte_column: z.number().int().optional(),
  text: z.string().optional(),
  text_truncated: z.boolean().optional(),
}).passthrough();

const resultSchema = z.object({
  path: z.string(),
  type: z.string().optional(),
  matched_in: z.array(z.string()).optional(),
  matches: z.array(matchSchema).optional(),
  matches_truncated: z.boolean().optional(),
  size: z.number().int().nonnegative().optional(),
  modified_at: z.string().optional(),
  storage_id: z.string(),
  storage_name: z.string().optional(),
  download: z.object({
    status: z.string().optional(),
    url: z.string().optional(),
    expires_at: z.string().optional(),
  }).optional(),
}).passthrough();

const findResultSchema = z.object({
  result_kind: z.string().optional(),
  results: z.array(resultSchema),
  truncated: z.boolean().optional(),
  search_in: z.string().optional(),
  storages: z.array(z.unknown()).optional(),
}).passthrough();

type MaruResult = z.infer<typeof resultSchema>;

export class MaruClient {
  private readonly connection: McpConnection;

  constructor(
    token: string,
    appVersion: string,
    private readonly cacheDirectory: string,
    private readonly tomato: TomatoClient,
    private readonly endpoint = DEFAULT_MARU_ENDPOINT,
  ) {
    this.connection = new McpConnection({
      id: "maru",
      endpoint,
      clientName: "ketchupe",
      clientVersion: appVersion,
      token: async () => token,
      allowedTools: MARU_TOOLS,
    });
  }

  async call(tool: (typeof MARU_TOOLS)[number], args: Record<string, unknown>, signal: AbortSignal): Promise<ExternalCallResult> {
    const payload = await this.callPayload(tool, args, signal);
    if (tool === "find_storage") return normalizeMaruFindResult(payload);
    return { summary: JSON.stringify(sanitizeMaruResult(payload), null, 2), documents: [] };
  }

  async readDocument(document: ExternalDocumentRef, signal: AbortSignal): Promise<IngestedSource> {
    const payload = await this.callPayload("find_storage", {
      storage_id: document.storageId,
      file_path: document.path,
    }, signal);
    const parsed = findResultSchema.safeParse(payload);
    if (!parsed.success) throw new AgentError("TOOL_UNAVAILABLE", "MARU returned an invalid file lookup result");
    const file = parsed.data.results.find((item) => item.storage_id === document.storageId && item.path === document.path);
    if (!file?.download?.url || file.download.status !== "ready") {
      throw new AgentError("TOOL_UNAVAILABLE", "MARU did not return a downloadable file");
    }
    const localPath = await this.download(file, document.refId, signal);
    const collection = `maru_${document.refId}`;
    const relativePath = `${document.storageName ?? document.storageId}/${document.path}`.replaceAll("\\", "/").replace(/^\/+/, "");
    return this.tomato.ingestFile(localPath, collection, relativePath);
  }

  async close(): Promise<void> {
    await this.connection.close();
  }

  private async callPayload(tool: (typeof MARU_TOOLS)[number], args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const result = await this.connection.callTool(tool, args, signal);
    if (result.isError) throw new AgentError("TOOL_UNAVAILABLE", `MARU ${tool} returned an error`);
    return payloadOf(result);
  }

  private async download(file: MaruResult, refId: string, signal: AbortSignal): Promise<string> {
    if (file.size && file.size > MAX_DOWNLOAD_BYTES) throw new AgentError("TOOL_UNAVAILABLE", "MARU file exceeds the 100 MB download limit");
    const url = new URL(file.download?.url ?? "");
    if (url.protocol !== "https:" || url.origin !== this.endpoint.origin || url.username || url.password) {
      throw new AgentError("TOOL_UNAVAILABLE", "MARU returned an untrusted download URL");
    }
    const extension = extname(file.path).toLowerCase();
    if (!extension) throw new AgentError("TOOL_UNAVAILABLE", "MARU file has no extension");
    await mkdir(this.cacheDirectory, { recursive: true });
    const version = createHash("sha256").update(`${file.modified_at ?? ""}\u0000${file.size ?? ""}`).digest("hex").slice(0, 12);
    const localPath = join(this.cacheDirectory, `${refId}-${version}${extension}`);
    if (await cachedFileMatches(localPath, file.size)) return localPath;

    const response = await fetch(url, { signal, redirect: "error" });
    if (!response.ok || !response.body) throw new AgentError("TOOL_UNAVAILABLE", `MARU download failed (${response.status})`);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
      await response.body.cancel();
      throw new AgentError("TOOL_UNAVAILABLE", "MARU file exceeds the 100 MB download limit");
    }

    const reader = response.body.getReader();
    const temporary = `${localPath}.${process.pid}.${Date.now()}.tmp`;
    const output = await open(temporary, "wx");
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_DOWNLOAD_BYTES) {
          await reader.cancel();
          throw new AgentError("TOOL_UNAVAILABLE", "MARU file exceeds the 100 MB download limit");
        }
        await output.writeFile(value);
      }
      await output.close();
      await rename(temporary, localPath);
    } catch (error) {
      await output.close().catch(() => undefined);
      await reader.cancel().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    return localPath;
  }
}

function payloadOf(result: CallToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  if (!text) return result.content ?? [];
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function normalizeMaruFindResult(payload: unknown): ExternalCallResult {
  const parsed = findResultSchema.safeParse(payload);
  if (!parsed.success) {
    return { summary: JSON.stringify({ error: "MARU returned an unsupported find_storage result shape" }), documents: [] };
  }
  const documents = parsed.data.results.slice(0, MAX_SAFE_RESULTS)
    .filter((item) => item.type === "file")
    .map(toDocumentRef);
  const safeResults = parsed.data.results.slice(0, MAX_SAFE_RESULTS).map((item) => ({
    ref_id: item.type === "file" ? refId(item.storage_id, item.path) : undefined,
    path: item.path,
    type: item.type,
    matched_in: item.matched_in,
    matches: item.matches?.slice(0, 2).map((match) => ({
      line: match.line,
      byte_column: match.byte_column,
      text: match.text?.slice(0, 400),
      text_truncated: match.text_truncated || (match.text?.length ?? 0) > 400,
    })),
    matches_truncated: item.matches_truncated || (item.matches?.length ?? 0) > 2,
    size: item.size,
    modified_at: item.modified_at,
    storage_id: item.storage_id,
    storage_name: item.storage_name,
    download: { status: item.download?.status, expires_at: item.download?.expires_at },
  }));
  return {
    summary: JSON.stringify({
      result_kind: parsed.data.result_kind,
      results: safeResults,
      omitted_results: Math.max(0, parsed.data.results.length - safeResults.length),
      truncated: parsed.data.truncated,
      search_in: parsed.data.search_in,
      storages: sanitizeMaruResult(parsed.data.storages),
    }, null, 2),
    documents,
  };
}

function toDocumentRef(item: MaruResult): ExternalDocumentRef {
  return {
    refId: refId(item.storage_id, item.path),
    provider: "maru",
    storageId: item.storage_id,
    ...(item.storage_name ? { storageName: item.storage_name } : {}),
    path: item.path,
    ...(item.size !== undefined ? { size: item.size } : {}),
    ...(item.modified_at ? { modifiedAt: item.modified_at } : {}),
  };
}

function refId(storageId: string, path: string): string {
  return createHash("sha256").update(`maru\u0000${storageId}\u0000${path}`).digest("hex").slice(0, 16);
}

async function cachedFileMatches(path: string, expectedSize?: number): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0 && (expectedSize === undefined || info.size === expectedSize);
  } catch {
    return false;
  }
}
