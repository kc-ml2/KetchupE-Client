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
/** Chat retrieval: literal keywords × storages fanned out per question, top files read back as excerpts. */
const MAX_KEYWORDS = 3;
const MAX_SEARCH_CALLS = 6;
const RESULTS_PER_CALL = 5;
const MAX_EXCERPT_FILES = 4;
export const MARU_EXCERPT_CHARS = 1000;
const EXCERPT_LEAD_CHARS = 300;

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
  content: z.object({ status: z.string(), text: z.string().optional() }).passthrough().optional(),
}).passthrough();

const storageListSchema = z.object({
  results: z.array(z.object({ storage_id: z.string(), storage_name: z.string().optional() }).passthrough()),
}).passthrough();

export type MaruStorage = { storageId: string; name: string };
export type MaruExcerpt = { document: ExternalDocumentRef; text: string };

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
    private readonly onRead?: (document: ExternalDocumentRef, localPath: string) => void,
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

  /** Storage roots the account's teams can read. */
  async listStorages(signal: AbortSignal): Promise<MaruStorage[]> {
    const parsed = storageListSchema.safeParse(await this.callPayload("browse_storage", { max_results: 200 }, signal));
    if (!parsed.success) throw new AgentError("TOOL_UNAVAILABLE", "MARU returned an invalid storage list");
    return parsed.data.results.map((item) => ({ storageId: item.storage_id, name: item.storage_name ?? item.storage_id }));
  }

  /**
   * MARU search is a literal ripgrep match (including pre-extracted PDF/Office/HWP text), so a question is reduced to
   * keywords first. With nothing excluded, MARU itself searches every accessible storage.
   */
  async searchExcerpts(question: string, excludedStorageIds: string[], signal: AbortSignal): Promise<MaruExcerpt[]> {
    const keywords = maruKeywords(question);
    if (!keywords.length) return [];
    const scopes: Array<string | undefined> = excludedStorageIds.length
      ? (await this.listStorages(signal)).map((storage) => storage.storageId).filter((id) => !excludedStorageIds.includes(id))
      : [undefined];
    if (!scopes.length) return [];
    const calls = keywords.flatMap((keyword) => scopes.map((storageId) => ({ keyword, storageId }))).slice(0, MAX_SEARCH_CALLS);
    const settled = await Promise.allSettled(calls.map(({ keyword, storageId }) => this.callPayload("find_storage", {
      query: keyword,
      ...(storageId ? { storage_id: storageId } : {}),
      include_content: true,
      max_results: RESULTS_PER_CALL,
    }, signal).then((payload) => ({ keyword, payload }))));
    signal.throwIfAborted();
    if (settled.every((item) => item.status === "rejected")) throw (settled[0] as PromiseRejectedResult).reason;
    return rankExcerpts(settled.flatMap((item) => item.status === "fulfilled" ? [item.value] : []));
  }

  async readDocument(document: ExternalDocumentRef, signal: AbortSignal): Promise<IngestedSource> {
    const file = await this.authorizeDocument(document, signal);
    if (!file.download?.url || file.download.status !== "ready") {
      throw new AgentError("TOOL_UNAVAILABLE", "MARU did not return a downloadable file");
    }
    const localPath = await this.download(file, document.refId, signal);
    signal.throwIfAborted();
    this.onRead?.(document, localPath);
    const collection = `maru_${document.refId}`;
    const relativePath = `${document.storageName ?? document.storageId}/${document.path}`.replaceAll("\\", "/").replace(/^\/+/, "");
    return this.tomato.ingestFile(localPath, collection, relativePath);
  }

  async authorizeDocument(document: ExternalDocumentRef, signal: AbortSignal): Promise<MaruResult> {
    const payload = await this.callPayload("find_storage", {
      storage_id: document.storageId,
      file_path: document.path,
    }, signal);
    const parsed = findResultSchema.safeParse(payload);
    if (!parsed.success) throw new AgentError("TOOL_UNAVAILABLE", "MARU returned an invalid file lookup result");
    const file = parsed.data.results.find((item) => item.storage_id === document.storageId && item.path === document.path);
    if (!file) throw new AgentError("TOOL_UNAVAILABLE", "MARU 문서 접근 권한을 확인하지 못했습니다.");
    signal.throwIfAborted();
    return file;
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
    excerpts: parsed.data.results.slice(0, MAX_SAFE_RESULTS).filter((item) => item.type === "file").flatMap((item) =>
      (item.matches ?? []).slice(0, 2).filter((match) => Boolean(match.text?.trim())).map((match) => ({ document: toDocumentRef(item), text: match.text!.slice(0, 400) }))),
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

// Longer endings first: the first suffix that matches is stripped.
const JOSA = ["하려면", "에서는", "하면", "되면", "에는", "으로", "에서", "에게", "까지", "부터", "처럼", "보다", "이랑", "하고", "의", "을", "를", "이", "가", "은", "는", "에", "와", "과", "도", "로", "만"];
const STOPWORDS = new Set(["maru", "마루", "공유", "저장소", "문서", "파일", "자료", "내용", "관련", "대해", "대한", "어떻게", "무엇", "뭐야", "뭔가요", "알려줘", "찾아줘", "검색", "검색해줘", "정리해줘", "있어", "있나요", "해줘", "주세요", "에서"]);

/** ponytail: particle-stripping heuristic, not a morphological analyzer. Swap in model-extracted keywords if recall suffers. */
export function maruKeywords(question: string): string[] {
  const tokens = question.normalize("NFC").toLowerCase().split(/[^\p{L}\p{N}_.-]+/u).map((token) => {
    const josa = JOSA.find((suffix) => token.endsWith(suffix) && token.length > suffix.length + 1);
    return josa ? token.slice(0, -josa.length) : token;
  });
  const keywords = tokens.filter((token) => token.length >= 2 && !STOPWORDS.has(token) && !/(줘|요|까|니|나|죠)$/u.test(token));
  return [...new Set(keywords)].sort((a, b) => b.length - a.length).slice(0, MAX_KEYWORDS);
}

/** Files matching more keywords first; only complete text yields an excerpt (too_large/budget-exceeded files are skipped). */
function rankExcerpts(responses: Array<{ keyword: string; payload: unknown }>): MaruExcerpt[] {
  const files = new Map<string, { item: MaruResult; keywords: Set<string>; text?: string }>();
  for (const { keyword, payload } of responses) {
    const parsed = findResultSchema.safeParse(payload);
    if (!parsed.success) continue;
    for (const item of parsed.data.results) {
      if (item.type && item.type !== "file") continue;
      const key = `${item.storage_id}\u0000${item.path}`;
      const entry = files.get(key) ?? { item, keywords: new Set<string>() };
      entry.keywords.add(keyword);
      if (item.content?.status === "complete" && item.content.text) entry.text = item.content.text;
      files.set(key, entry);
    }
  }
  return [...files.values()]
    .filter((entry) => entry.text?.trim())
    .sort((a, b) => b.keywords.size - a.keywords.size || a.item.path.localeCompare(b.item.path))
    .slice(0, MAX_EXCERPT_FILES)
    .map((entry) => ({ document: toDocumentRef(entry.item), text: excerptAround(entry.text!, [...entry.keywords]) }));
}

/** About MARU_EXCERPT_CHARS of text starting a little before the first keyword hit. */
export function excerptAround(text: string, keywords: string[]): string {
  const lower = text.toLowerCase();
  const hit = Math.min(...keywords.map((keyword) => lower.indexOf(keyword.toLowerCase())).filter((index) => index >= 0), Number.POSITIVE_INFINITY);
  const start = Number.isFinite(hit) ? Math.max(0, hit - EXCERPT_LEAD_CHARS) : 0;
  return text.slice(start, start + MARU_EXCERPT_CHARS).replace(/\s+/g, " ").trim();
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
