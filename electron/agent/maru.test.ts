// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { TomatoClient } from "../tomato/tomatoClient.ts";
import { McpConnection } from "./mcp.ts";
import { MaruClient, normalizeMaruFindResult, sanitizeMaruResult } from "./maru.ts";

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
