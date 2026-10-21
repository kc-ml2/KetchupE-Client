// @vitest-environment node
import { expect, it } from "vitest";
import { cosineSimilarity, EMBEDDING_MAX_TOKENS, EMBEDDING_PROFILE, EMBEDDING_WINDOW_TOKENS, poolWindowVectors, splitIntoWindows } from "./embedding.ts";
import { dot, HnswIndex } from "./hnsw.ts";
import { estimateTokens } from "./text.ts";

const measure = estimateTokens;

it("short passages stay a single window with the header attached", () => {
  const windows = splitIntoWindows({ header: "인사 규정\n계약 해지", body: "계약 해지는 퇴직 희망일 30일 전에 신청합니다." }, measure, 480);
  expect(windows).toHaveLength(1);
  expect(windows[0].text.startsWith("인사 규정\n계약 해지\n")).toBe(true);
  expect(windows[0].tokens).toBeLessThanOrEqual(480);
});

it("long chunks are windowed under the model cap and every window keeps the header", () => {
  const sentence = "제 12 조 계약의 해지는 당사자 일방의 서면 통지로 효력이 발생하며 통지일로부터 삼십 일이 경과한 날에 종료된다. ";
  const body = sentence.repeat(40); // ≈ 2,400 CJK tokens by the heuristic, well above 850
  expect(measure(body)).toBeGreaterThan(EMBEDDING_MAX_TOKENS);
  const windows = splitIntoWindows({ header: "표준 계약서\n제 3 장 계약의 종료", body }, measure, EMBEDDING_WINDOW_TOKENS);
  expect(windows.length).toBeGreaterThan(3);
  for (const window of windows) {
    expect(window.tokens).toBeLessThanOrEqual(EMBEDDING_WINDOW_TOKENS);
    expect(window.text.startsWith("표준 계약서\n제 3 장 계약의 종료\n")).toBe(true);
  }
  // Nothing is dropped: every sentence of the body appears in exactly one window.
  const joined = windows.map((window) => window.text.split("\n").slice(2).join("\n")).join(" ");
  expect(joined.split("종료된다.").length - 1).toBe(40);
});

it("a single oversized sentence is hard-split instead of truncated", () => {
  const body = "가".repeat(1500);
  const windows = splitIntoWindows(body, measure, 480);
  expect(windows.length).toBe(Math.ceil(1500 / 480));
  expect(windows.every((window) => window.tokens <= 480)).toBe(true);
  expect(windows.map((window) => window.text).join("")).toBe(body);
});

it("window vectors pool to one unit vector weighted by tokens", () => {
  const a = new Float32Array([1, 0, 0]);
  const b = new Float32Array([0, 1, 0]);
  const pooled = poolWindowVectors([a, b], [300, 100]);
  expect(Math.abs(Math.hypot(...pooled) - 1)).toBeLessThan(1e-6);
  expect(pooled[0]).toBeGreaterThan(pooled[1]);
  expect(cosineSimilarity(pooled, a)).toBeGreaterThan(cosineSimilarity(pooled, b));
  expect(poolWindowVectors([a], [10])).toBe(a);
  expect(EMBEDDING_PROFILE).toContain(`win${EMBEDDING_WINDOW_TOKENS}`);
});

function randomUnit(dimensions: number, random: () => number): Float32Array {
  const vector = new Float32Array(dimensions);
  for (let index = 0; index < dimensions; index += 1) vector[index] = random() * 2 - 1;
  const norm = Math.hypot(...vector);
  for (let index = 0; index < dimensions; index += 1) vector[index] /= norm;
  return vector;
}

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

it("HNSW recall against brute force stays high on a corpus above the exact threshold", () => {
  const dimensions = 48;
  const count = 3000;
  const k = 10;
  const random = seeded(7);
  const vectors = Array.from({ length: count }, () => randomUnit(dimensions, random));
  const index = new HnswIndex({ dimensions, exactBelow: 100, m: 16, efConstruction: 100, seed: 1 });
  vectors.forEach((vector, position) => index.add(`c${position}`, vector));
  expect(index.size).toBe(count);

  let overlap = 0;
  const queries = 30;
  for (let trial = 0; trial < queries; trial += 1) {
    const query = randomUnit(dimensions, random);
    const exact = vectors
      .map((vector, position) => ({ id: `c${position}`, score: dot(query, vector) }))
      .sort((left, right) => right.score - left.score)
      .slice(0, k)
      .map((hit) => hit.id);
    const approximate = index.search(query, k, 128).map((hit) => hit.id);
    expect(approximate).toHaveLength(k);
    overlap += approximate.filter((id) => exact.includes(id)).length;
  }
  expect(overlap / (queries * k)).toBeGreaterThanOrEqual(0.9);
}, 30_000);

it("HNSW is exact below the threshold and honours upserts and removals", () => {
  const dimensions = 8;
  const random = seeded(3);
  const index = new HnswIndex({ dimensions, exactBelow: 1000 });
  const vectors = Array.from({ length: 50 }, () => randomUnit(dimensions, random));
  vectors.forEach((vector, position) => index.add(`c${position}`, vector));
  const query = vectors[17];
  expect(index.search(query, 1)[0]).toMatchObject({ id: "c17" });
  expect(index.search(query, 1)[0].score).toBeCloseTo(1, 5);

  index.remove("c17");
  expect(index.has("c17")).toBe(false);
  expect(index.size).toBe(49);
  expect(index.search(query, 1)[0].id).not.toBe("c17");

  index.add("c3", query); // upsert c3 to the removed vector
  expect(index.search(query, 1)[0].id).toBe("c3");
  expect(index.size).toBe(49);

  // Compaction drops tombstones but keeps answers.
  expect(index.compact()).toBe(49);
  expect(index.capacity).toBe(49);
  expect(index.search(query, 1)[0].id).toBe("c3");
});

it("HNSW search works on the approximate path after many deletions", () => {
  const dimensions = 16;
  const random = seeded(11);
  const index = new HnswIndex({ dimensions, exactBelow: 10, seed: 5 });
  const vectors = Array.from({ length: 600 }, () => randomUnit(dimensions, random));
  vectors.forEach((vector, position) => index.add(`c${position}`, vector));
  for (let position = 0; position < 300; position += 1) index.remove(`c${position}`);
  const hits = index.search(vectors[450], 5);
  expect(hits[0].id).toBe("c450");
  expect(hits.every((hit) => Number(hit.id.slice(1)) >= 300)).toBe(true);
  expect(index.needsCompaction()).toBe(true);
  index.compact();
  expect(index.capacity).toBe(300);
  expect(index.search(vectors[450], 1)[0].id).toBe("c450");
});

it("HNSW graph round-trips through toGraph/vectorData/restore", () => {
  const dimensions = 12;
  const random = seeded(21);
  const index = new HnswIndex({ dimensions, exactBelow: 0, seed: 9 });
  const vectors = Array.from({ length: 300 }, () => randomUnit(dimensions, random));
  vectors.forEach((vector, position) => index.add(`c${position}`, vector));
  index.remove("c5");

  const restored = HnswIndex.restore(index.toGraph(), index.vectorData(), { exactBelow: 0 });
  expect(restored.size).toBe(299);
  expect(restored.has("c5")).toBe(false);
  for (const probe of [1, 42, 123, 299]) {
    expect(restored.search(vectors[probe], 3).map((hit) => hit.id)).toEqual(index.search(vectors[probe], 3).map((hit) => hit.id));
  }
  restored.add("c300", randomUnit(dimensions, random));
  expect(restored.size).toBe(300);
  expect(() => HnswIndex.restore(index.toGraph(), new Float32Array(3))).toThrow();
});
