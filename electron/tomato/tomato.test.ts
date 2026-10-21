// @vitest-environment node
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { blobToVector, cosineSimilarity, vectorToBlob } from "./embedding.ts";
import { createHash } from "node:crypto";
import { chunkMarkdown, corpusFingerprint, normalizeArticleBlocks, PIPELINE_FINGERPRINT, reciprocalRankFusion, Tomato, type SearchResult } from "./tomato.ts";

let temporary: string;
let documents: string;
let home: string;
let handbook: string;

beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), "tomato-smoke-"));
  documents = join(temporary, "documents");
  home = join(temporary, "home");
  handbook = join(documents, "handbook.md");
  await mkdir(documents);
  await writeFile(handbook, `# 인사 규정

## 계약 해지

계약 해지는 퇴직 희망일 30일 전에 신청합니다.

| 구분 | 제출 서류 |
| --- | --- |
| 정규직 | 퇴직원 |
| 계약직 | 종료 확인서 |
`);
});

afterAll(async () => {
  await rm(temporary, { recursive: true, force: true });
});

it("structure chunks and incremental Korean BM25 search work end to end", async () => {
  const chunks = chunkMarkdown("source", "fallback", await readFile(handbook, "utf8"));
  expect(chunks.some((chunk) => chunk.type === "table" && chunk.body.includes("종료 확인서"))).toBe(true);
  expect(chunks.every((chunk) => chunk.breadcrumb.at(-1) === "계약 해지")).toBe(true);
  expect(chunks.every((chunk) => chunk.tokenCount <= 850)).toBe(true);

  const tomato = new Tomato(home);
  const collection = await tomato.registerCollection(documents, "work");
  expect(collection.path).toBe(await realpath(documents));
  const status = await tomato.status();
  expect(status[0]).toMatchObject({ name: "work", sources: 1, embedded: 0 });
  const expectedFingerprint = corpusFingerprint([{ relativePath: "handbook.md", contentHash: createHash("sha256").update(await readFile(handbook)).digest("hex") }]);
  expect(await tomato.collectionFingerprint("work")).toBe(expectedFingerprint);
  expect(expectedFingerprint).toMatch(/^[0-9a-f]{64}$/);

  // hybrid requested, embeddings missing → keyword fallback
  const search = await tomato.search("계약 해지", { collections: ["work"], mode: "hybrid" });
  expect(search.effectiveMode).toBe("keyword");
  expect(search.results[0]?.path).toBe(await realpath(handbook));
  expect(search.results[0]?.breadcrumb.at(-1)).toBe("계약 해지");
  expect((await tomato.search("퇴직", { collections: ["work"] })).results.length).toBeGreaterThan(0);
  expect((await tomato.search("퇴직", { collections: [] })).results).toEqual([]);
  expect((await tomato.search("퇴직", { collections: ["other"] })).results).toEqual([]);

  const neighbors = await tomato.getNeighbors(search.results[0].chunkId, 1, 1);
  expect(neighbors.some((chunk) => chunk.chunkId === search.results[0].chunkId)).toBe(true);

  const unchanged = await tomato.sync("work");
  expect(unchanged.unchanged).toBe(1);
  expect(unchanged.pipelineFingerprint).toBe(PIPELINE_FINGERPRINT);

  await rm(join(home, "indexes", PIPELINE_FINGERPRINT.slice(0, 16)), { recursive: true, force: true });
  expect((await tomato.sync("work")).updated).toBe(1);
  expect((await tomato.search("계약 해지", { collections: ["work"] })).results.length).toBeGreaterThan(0);

  await writeFile(handbook, "# 보안 규정\n\n## 반출\n\n기밀자료 반출은 승인이 필요합니다.\n");
  expect((await tomato.sync("work")).updated).toBe(1);
  expect((await tomato.search("퇴직원", { collections: ["work"] })).results.length).toBe(0);
  expect((await tomato.search("기밀자료", { collections: ["work"] })).results.length).toBe(1);

  await rm(handbook);
  expect((await tomato.sync("work")).removed).toBe(1);
  expect((await tomato.search("기밀자료", { collections: ["work"] })).results.length).toBe(0);

  await tomato.remove("work");
  expect(await tomato.listCollections()).toEqual([]);
});

it("vector helpers and RRF fusion", () => {
  const vector = new Float32Array([0.25, -0.5, 0.75]);
  expect([...blobToVector(vectorToBlob(vector))]).toEqual([...vector]);
  expect(Math.abs(cosineSimilarity(vector, vector) - 1) < 1e-6).toBe(true);
  const result = (chunkId: string): SearchResult => ({
    id: chunkId, chunkId, sourceId: chunkId, score: 1, collection: "work", path: `/${chunkId}`,
    relativePath: chunkId, title: chunkId, breadcrumb: [], snippet: chunkId,
  });
  const fused = reciprocalRankFusion([result("both"), result("keyword")], [result("both"), result("semantic")], 3);
  expect(fused[0].chunkId).toBe("both");
  expect(fused[0].mode).toBe("hybrid");
});

it("indexes one app-managed external file without registering its cache folder", async () => {
  const remoteFile = join(temporary, "maru-policy.md");
  await writeFile(remoteFile, "# 보안 정책\n\n외부 공유 문서는 워터마크를 포함해야 합니다.\n");
  const tomato = new Tomato(join(temporary, "external-home"));
  const indexed = await tomato.ingestFile(remoteFile, "maru_a1b2c3", "공유문서/보안 정책.md");

  expect(indexed).toMatchObject({ collection: "maru_a1b2c3", relativePath: "공유문서/보안 정책.md", chunks: 1 });
  expect(await tomato.listCollections()).toEqual([]);
  const result = await tomato.search("워터마크", { collections: [indexed.collection], mode: "hybrid" });
  expect(result.effectiveMode).toBe("keyword");
  expect(result.results[0]).toMatchObject({ sourceId: indexed.sourceId, relativePath: "공유문서/보안 정책.md" });
});

it("promotes contract articles to headings and numbers 항 items", () => {
  const blocks = normalizeArticleBlocks([
    { type: "paragraph", text: "표준 개발용역 위탁 계약서", style: { bold: true } },
    { type: "paragraph", text: "제 1 조 (목적 및 범위)", style: { bold: true } },
    { type: "list", listType: "ordered", text: "본 계약은 목적을 정한다." },
    { type: "list", listType: "ordered", text: "범위는 별첨으로 정한다." },
    { type: "paragraph", text: "제18조 (지체상금)" },
    { type: "list", listType: "ordered", text: "지체일수에 요율을 곱한다." },
  ]);
  expect(blocks.map((block) => block.type)).toEqual(["paragraph", "heading", "paragraph", "paragraph", "heading", "paragraph"]);
  expect(blocks[2].text).toBe("1. 본 계약은 목적을 정한다.");
  expect(blocks[3].text).toBe("2. 범위는 별첨으로 정한다.");
  expect(blocks[5].text).toBe("1. 지체일수에 요율을 곱한다.");
  expect(new Tomato("/tmp/x", { parser: { articleHeadings: false } }).fingerprint).not.toBe(PIPELINE_FINGERPRINT);
  expect(new Tomato("/tmp/x", { chunk: { targetTokens: 300, maxTokens: 400 } }).profile.chunker.targetTokens).toBe(300);
  expect(new Tomato("/tmp/x").fingerprint).toBe(PIPELINE_FINGERPRINT);
});
