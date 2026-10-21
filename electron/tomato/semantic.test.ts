// @vitest-environment node
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { EMBEDDING_DIMENSIONS, type EmbeddingInput } from "./embedding.ts";
import { PIPELINE_FINGERPRINT, Tomato } from "./tomato.ts";

/**
 * Deterministic stand-in for the e5 model: a bag-of-characters vector, so an exact or near-exact
 * restatement of a passage lands closest to it. Lets the semantic → HNSW → RRF path run without a model.
 */
function fakeEmbed(text: string): Float32Array {
  const vector = new Float32Array(EMBEDDING_DIMENSIONS);
  for (const character of text.replace(/\s+/g, "")) {
    vector[character.codePointAt(0)! % EMBEDDING_DIMENSIONS] += 1;
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let index = 0; index < vector.length; index += 1) vector[index] /= norm;
  return vector;
}

vi.mock("./embedding.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./embedding.ts")>();
  return {
    ...actual,
    embedTexts: vi.fn(async (inputs: EmbeddingInput[]) => inputs.map((input) => fakeEmbed(typeof input === "string" ? input : input.body))),
  };
});

let temporary: string;
let documents: string;
let home: string;

beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), "tomato-semantic-"));
  documents = join(temporary, "documents");
  home = join(temporary, "home");
  await mkdir(documents);
  await writeFile(join(documents, "hr.md"), `# 인사 규정

## 연차

연차 휴가는 입사일 기준으로 매년 15일이 부여됩니다.

## 계약 해지

계약 해지는 퇴직 희망일 30일 전에 서면으로 신청합니다.
`);
  await writeFile(join(documents, "finance.md"), `# 재무 규정

## 일일 자금

일일 자금 일보는 매 영업일 오전 9시에 작성합니다.
`);
});

afterAll(async () => {
  await rm(temporary, { recursive: true, force: true });
});

it("semantic search runs through the ANN index, persists it, and fuses with keyword results", async () => {
  const tomato = new Tomato(home);
  await tomato.registerCollection(documents, "work");

  const report = await tomato.embedMissing("work");
  expect(report.embedded).toBeGreaterThan(0);
  expect(report.skipped).toBe(0);

  const semantic = await tomato.search("일일 자금 일보는 매 영업일 오전 9시에 작성합니다.", { collections: ["work"], mode: "semantic" });
  expect(semantic.effectiveMode).toBe("semantic");
  expect(semantic.results[0]?.relativePath).toBe("finance.md");
  expect(semantic.results[0]?.score).toBeGreaterThan(0.9);

  const hybrid = await tomato.search("계약 해지 서면 신청", { collections: ["work"], mode: "hybrid" });
  expect(hybrid.effectiveMode).toBe("hybrid");
  expect(hybrid.results[0]?.breadcrumb.at(-1)).toBe("계약 해지");
  expect(hybrid.results.every((result) => result.mode === "hybrid")).toBe(true);

  // The graph and packed vectors are written next to the SQLite index.
  const files = await readdir(join(home, "indexes", PIPELINE_FINGERPRINT.slice(0, 16)));
  expect(files).toContain("hnsw-work.json");
  expect(files).toContain("hnsw-work.f32");

  // A fresh instance restores the persisted index and reconciles edits made in between.
  await writeFile(join(documents, "finance.md"), `# 재무 규정

## 월간 결산

월간 결산 보고서는 매월 5일까지 제출합니다.
`);
  const restarted = new Tomato(home);
  await restarted.sync("work");
  await restarted.embedMissing("work");
  const after = await restarted.search("월간 결산 보고서는 매월 5일까지 제출합니다.", { collections: ["work"], mode: "semantic" });
  expect(after.results[0]?.breadcrumb.at(-1)).toBe("월간 결산");
  const stale = await restarted.search("일일 자금 일보는 매 영업일 오전 9시에 작성합니다.", { collections: ["work"], mode: "semantic" });
  expect(stale.results.every((result) => !result.snippet.includes("일일 자금"))).toBe(true);

  // Partial coverage still falls back to keyword search in hybrid mode.
  await writeFile(join(documents, "extra.md"), "# 추가\n\n## 메모\n\n새 문서입니다.\n");
  await restarted.sync("work");
  const fallback = await restarted.search("메모", { collections: ["work"], mode: "hybrid" });
  expect(fallback.effectiveMode).toBe("keyword");
});
