// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { TomatoClient } from "../tomato/tomatoClient.ts";
import { McpConnection } from "./mcp.ts";
import { excerptAround, MARU_EXCERPT_CHARS, MaruClient, maruKeywords, normalizeMaruFindResult, sanitizeMaruResult } from "./maru.ts";

it("removes credentials and download URLs from connection diagnostics", () => {
  expect(sanitizeMaruResult({
    storage_id: "storage-a",
    authorization: "Bearer synthetic-secret",
    nested: { download_url: "https://maru.ml2-alpha.com/files/download?token=synthetic", token: "synthetic" },
    message: "Download https://maru.ml2-alpha.com/files/download?token=synthetic",
  })).toEqual({ storage_id: "storage-a", nested: {}, message: "Download [URL omitted]" });
});

it("rechecks MARU access before using a cached document and refuses a later denial", async () => {
  const cache = await mkdtemp(join(tmpdir(), "maru-access-"));
  const modified = "2026-10-12T00:00:00Z";
  const version = createHash("sha256").update(`${modified}\u00004`).digest("hex").slice(0, 12);
  const cached = join(cache, `ref-a-${version}.txt`);
  await writeFile(cached, "test");
  const lookup = vi.spyOn(McpConnection.prototype, "callTool").mockResolvedValueOnce({
    content: [], structuredContent: { results: [{
      storage_id: "storage-a", path: "document.txt", size: 4, modified_at: modified,
      download: { status: "ready", url: "https://maru.ml2-alpha.com/files/download?token=synthetic" },
    }] },
  }).mockResolvedValueOnce({ content: [], isError: true });
  const fetch = vi.fn(() => { throw new Error("cached content must not be downloaded"); });
  vi.stubGlobal("fetch", fetch);
  const ingestFile = vi.fn().mockResolvedValue({ collection: "maru_ref-a", sourceId: "source-a", relativePath: "storage-a/document.txt", chunks: 1 });
  const client = new MaruClient("synthetic-token", "test", cache, { ingestFile } as unknown as TomatoClient);
  const document = { refId: "ref-a", provider: "maru" as const, storageId: "storage-a", path: "document.txt" };
  try {
    await expect(client.readDocument(document, new AbortController().signal)).resolves.toMatchObject({ sourceId: "source-a" });
    expect(lookup).toHaveBeenCalledWith("find_storage", { storage_id: "storage-a", file_path: "document.txt" }, expect.any(AbortSignal));
    expect(ingestFile).toHaveBeenCalledWith(cached, "maru_ref-a", "storage-a/document.txt");
    await expect(client.readDocument(document, new AbortController().signal)).rejects.toMatchObject({ code: "TOOL_UNAVAILABLE" });
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(ingestFile).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    lookup.mockRestore();
    vi.unstubAllGlobals();
    await rm(cache, { recursive: true, force: true });
  }
});

it("keeps signed download URLs out of MARU prompt and trace material", () => {
  const signedUrl = "https://maru.ml2-alpha.com/download/report.pdf?token=top-secret-signature";
  const normalized = normalizeMaruFindResult({
    result_kind: "matches",
    results: [{
      path: "규정/report.pdf",
      type: "file",
      matched_in: ["content"],
      matches: [{ line: 3, text: "연차는 수당으로 정산한다." }],
      size: 1234,
      modified_at: "2026-09-17T00:00:00Z",
      storage_id: "storage-1",
      storage_name: "공유문서",
      download: { status: "ready", url: signedUrl, expires_at: "2026-09-17T00:05:00Z" },
    }],
  });

  expect(normalized.documents).toEqual([expect.objectContaining({ provider: "maru", storageId: "storage-1", path: "규정/report.pdf" })]);
  expect(normalized.summary).toContain("ref_id");
  expect(normalized.summary).toContain("expires_at");
  expect(normalized.summary).not.toContain(signedUrl);
  expect(normalized.summary).not.toContain("top-secret-signature");
});

it("does not echo an unrecognized MARU result that may contain a URL", () => {
  const normalized = normalizeMaruFindResult("download https://maru.ml2-alpha.com/file?token=secret");
  expect(normalized.documents).toEqual([]);
  expect(normalized.summary).toContain("unsupported");
  expect(normalized.summary).not.toContain("token=secret");
});

it("reduces a chat question to literal MARU keywords", () => {
  const keywords = maruKeywords("MARU에서 연차수당 정산 규정을 찾아줘");
  expect(keywords).toEqual(["연차수당", "정산", "규정"]);
  expect(maruKeywords("결혼하면 KC에서 휴가 보내줘?")).toEqual(["결혼", "kc", "휴가"]);
});

it("cuts about 1000 characters starting shortly before the first keyword hit", () => {
  const text = `${"가".repeat(2000)}연차 정산${"나".repeat(2000)}`;
  const excerpt = excerptAround(text, ["정산"]);
  expect(excerpt).toHaveLength(MARU_EXCERPT_CHARS);
  expect(excerpt).toContain("연차 정산");
  expect(excerptAround("짧은 본문", ["없음"])).toBe("짧은 본문");
});

it("fans keywords out per storage, ranks files by keyword hits and skips files without complete text", async () => {
  const file = (path: string, content?: { status: string; text?: string }) => ({ path, type: "file", storage_id: "s1", storage_name: "인사팀", ...(content ? { content } : {}) });
  const calls: Array<Record<string, unknown>> = [];
  const lookup = vi.spyOn(McpConnection.prototype, "callTool").mockImplementation(async (tool, args) => {
    if (tool === "browse_storage") return { content: [], structuredContent: { results: [{ storage_id: "s1" }, { storage_id: "s-off" }] } };
    calls.push(args);
    if (args.query === "규정") throw new Error("one keyword failing must not drop the others");
    const results = args.query === "연차수당"
      ? [file("a.hwp", { status: "complete", text: "서문. 연차수당은 정산한다." }), file("big.pdf", { status: "too_large" })]
      : [file("a.hwp", { status: "complete", text: "서문. 연차수당은 정산한다." }), file("b.docx", { status: "complete", text: "정산 절차" })];
    return { content: [], structuredContent: { results } };
  });
  const client = new MaruClient("synthetic-token", "test", "/unused", {} as TomatoClient);
  try {
    const excerpts = await client.searchExcerpts("연차수당 정산 규정", ["s-off"], new AbortController().signal);
    expect(calls).toEqual(["연차수당", "정산", "규정"].map((query) => ({ query, storage_id: "s1", include_content: true, max_results: 5 })));
    expect(excerpts.map((item) => item.document.path)).toEqual(["a.hwp", "b.docx"]);
    expect(excerpts[0]).toMatchObject({ document: { provider: "maru", storageId: "s1", storageName: "인사팀" }, text: "서문. 연차수당은 정산한다." });
  } finally {
    lookup.mockRestore();
  }
});
