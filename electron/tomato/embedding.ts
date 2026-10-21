import { mkdir } from "node:fs/promises";
import type { FeatureExtractionPipeline } from "@huggingface/transformers";
import { estimateTokens } from "./text.ts";

export const EMBEDDING_MODEL = "Xenova/multilingual-e5-small";
export const EMBEDDING_REVISION = "761b726dd34fb83930e26aab4e9ac3899aa1fa78";
export const EMBEDDING_DIMENSIONS = 384;
/** Hard input cap of the model (special tokens included). The pipeline truncates silently beyond it. */
export const EMBEDDING_MAX_TOKENS = 512;
/**
 * Text tokens per window. Leaves room for the e5 prefix, [CLS]/[SEP], and tokenizer/heuristic drift,
 * so no window is ever truncated by the model.
 */
export const EMBEDDING_WINDOW_TOKENS = 480;
/** Profile changes whenever vectors become incompatible; `embedMissing` re-embeds every chunk on a mismatch. */
export const EMBEDDING_PROFILE = `${EMBEDDING_MODEL}@${EMBEDDING_REVISION}:q8:mean:l2:e5-prefix-v1:win${EMBEDDING_WINDOW_TOKENS}-twmean-v1`;

/** A passage is a body plus an optional header (title/breadcrumb) that every window of the body repeats. */
export type EmbeddingInput = string | { header?: string; body: string };

export type TokenMeasure = (text: string) => number;

export interface EmbeddingWindow {
  text: string;
  tokens: number;
}

let extractorPromise: Promise<FeatureExtractionPipeline> | undefined;

const WINDOW_BATCH = 16;

async function loadExtractor(cacheDirectory: string): Promise<FeatureExtractionPipeline> {
  await mkdir(cacheDirectory, { recursive: true });
  if (!extractorPromise) {
    extractorPromise = import("@huggingface/transformers")
      .then(({ pipeline }) => pipeline("feature-extraction", EMBEDDING_MODEL, {
        revision: EMBEDDING_REVISION,
        dtype: "q8",
        cache_dir: cacheDirectory,
      }))
      .catch((error) => {
        extractorPromise = undefined;
        throw error;
      });
  }
  return extractorPromise;
}

/** Counts model tokens with the pipeline tokenizer; falls back to the CJK-aware heuristic when it is unavailable. */
function tokenMeasure(extractor: FeatureExtractionPipeline): TokenMeasure {
  const tokenizer = (extractor as unknown as { tokenizer?: { encode(text: string, options?: { add_special_tokens?: boolean }): number[] } }).tokenizer;
  if (!tokenizer || typeof tokenizer.encode !== "function") return estimateTokens;
  return (text) => tokenizer.encode(text, { add_special_tokens: false }).length;
}

/**
 * Embeds queries and passages without ever hitting the 512-token truncation of the model.
 *
 * Each input is split into windows of at most `EMBEDDING_WINDOW_TOKENS` measured tokens (sentence/line
 * boundaries first, character splits only for a single oversized sentence). Every window carries the
 * header, is embedded with the e5 prefix, and the window vectors are pooled by a token-weighted mean and
 * re-normalized, so a chunk yields exactly one 384-d unit vector and the `embeddings` schema is unchanged.
 */
export async function embedTexts(
  inputs: EmbeddingInput[],
  kind: "query" | "passage",
  cacheDirectory: string,
): Promise<Float32Array[]> {
  if (!inputs.length) return [];
  const extractor = await loadExtractor(cacheDirectory);
  const measure = tokenMeasure(extractor);
  const prefixTokens = measure(`${kind}: `);
  const budget = Math.max(32, Math.min(EMBEDDING_WINDOW_TOKENS, EMBEDDING_MAX_TOKENS - prefixTokens - 8));
  const windowsPerInput = inputs.map((input) => splitIntoWindows(input, measure, budget));
  const flat = windowsPerInput.flat();
  const vectors: Float32Array[] = [];
  for (let offset = 0; offset < flat.length; offset += WINDOW_BATCH) {
    const batch = flat.slice(offset, offset + WINDOW_BATCH);
    const output = await extractor(batch.map((window) => `${kind}: ${window.text}`), { pooling: "mean", normalize: true });
    const rows = output.tolist() as number[][];
    if (rows.length !== batch.length || rows.some((row) => row.length !== EMBEDDING_DIMENSIONS)) {
      throw new Error(`잘못된 embedding shape: ${JSON.stringify(output.dims)}`);
    }
    for (const row of rows) vectors.push(Float32Array.from(row));
  }
  const results: Float32Array[] = [];
  let cursor = 0;
  for (const windows of windowsPerInput) {
    const slice = vectors.slice(cursor, cursor + windows.length);
    cursor += windows.length;
    results.push(poolWindowVectors(slice, windows.map((window) => window.tokens)));
  }
  return results;
}

const SENTENCE_BOUNDARY = /(?<=[.!?。！？;:])\s+|(?<=\n)/u;

/**
 * Splits one input into windows whose measured token count never exceeds `budget`.
 * Exported for tests; `measure` is injected so the model is not needed to exercise it.
 */
export function splitIntoWindows(input: EmbeddingInput, measure: TokenMeasure, budget: number): EmbeddingWindow[] {
  const header = (typeof input === "string" ? "" : input.header ?? "").trim();
  const body = (typeof input === "string" ? input : input.body).trim();
  const whole = joinHeader(header, body);
  const wholeTokens = measure(whole);
  if (wholeTokens <= budget) return [{ text: whole, tokens: Math.max(1, wholeTokens) }];

  // The header rides along in every window; cap it so it can never crowd out the body.
  let headerText = header;
  let headerTokens = headerText ? measure(headerText) : 0;
  const headerCap = Math.floor(budget / 4);
  if (headerTokens > headerCap) {
    headerText = fitPrefix(headerText, measure, headerCap);
    headerTokens = headerText ? measure(headerText) : 0;
  }
  const bodyBudget = Math.max(16, budget - headerTokens - (headerText ? 1 : 0));

  const segments: string[] = [];
  for (const piece of body.split(SENTENCE_BOUNDARY)) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    if (measure(trimmed) <= bodyBudget) {
      segments.push(trimmed);
    } else {
      segments.push(...hardSplit(trimmed, measure, bodyBudget));
    }
  }

  const windows: EmbeddingWindow[] = [];
  let current: string[] = [];
  let currentTokens = 0;
  const flush = () => {
    if (!current.length) return;
    const text = joinHeader(headerText, current.join(" "));
    windows.push({ text, tokens: Math.max(1, measure(text)) });
    current = [];
    currentTokens = 0;
  };
  for (const segment of segments) {
    const tokens = measure(segment);
    if (current.length && currentTokens + tokens + 1 > bodyBudget) flush();
    current.push(segment);
    currentTokens += tokens + (current.length > 1 ? 1 : 0);
  }
  flush();
  // Measured joins can drift above the budget by a token or two; re-split any window that overshot.
  return windows.flatMap((window) => (window.tokens <= budget || !window.text.includes(" ")
    ? [window]
    : hardSplit(window.text, measure, budget).map((text) => ({ text, tokens: Math.max(1, measure(text)) }))));
}

/** Token-weighted mean of unit vectors, re-normalized. One window returns its vector unchanged. */
export function poolWindowVectors(vectors: Float32Array[], weights: number[]): Float32Array {
  if (!vectors.length) throw new Error("pool할 window vector가 없습니다.");
  if (vectors.length === 1) return vectors[0];
  const pooled = new Float32Array(vectors[0].length);
  let totalWeight = 0;
  vectors.forEach((vector, index) => {
    const weight = Math.max(1, weights[index] ?? 1);
    totalWeight += weight;
    for (let dimension = 0; dimension < pooled.length; dimension += 1) pooled[dimension] += vector[dimension] * weight;
  });
  let norm = 0;
  for (let dimension = 0; dimension < pooled.length; dimension += 1) {
    pooled[dimension] /= totalWeight;
    norm += pooled[dimension] ** 2;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) for (let dimension = 0; dimension < pooled.length; dimension += 1) pooled[dimension] /= norm;
  return pooled;
}

function joinHeader(header: string, body: string): string {
  return [header, body].filter(Boolean).join("\n");
}

/** Splits a single oversized segment by characters (binary search on the measured prefix) until each part fits. */
function hardSplit(text: string, measure: TokenMeasure, budget: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length) {
    if (measure(rest) <= budget) {
      parts.push(rest);
      break;
    }
    const prefix = fitPrefix(rest, measure, budget);
    const cut = prefix.length || 1; // never loop on a zero-length prefix
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  return parts.filter(Boolean);
}

/** Longest character prefix (preferring a whitespace boundary) whose measured tokens fit in `budget`. */
function fitPrefix(text: string, measure: TokenMeasure, budget: number): string {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measure(text.slice(0, middle)) <= budget) low = middle;
    else high = middle - 1;
  }
  if (low === 0) return "";
  const boundary = text.lastIndexOf(" ", low);
  return (boundary > low / 2 ? text.slice(0, boundary) : text.slice(0, low)).trim();
}

export function vectorToBlob(vector: Float32Array): Buffer {
  const blob = Buffer.allocUnsafe(vector.length * 4);
  for (let index = 0; index < vector.length; index += 1) blob.writeFloatLE(vector[index], index * 4);
  return blob;
}

export function blobToVector(blob: Uint8Array): Float32Array {
  if (blob.byteLength % 4 !== 0) throw new Error(`잘못된 vector byte length: ${blob.byteLength}`);
  const view = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  const vector = new Float32Array(blob.byteLength / 4);
  for (let index = 0; index < vector.length; index += 1) vector[index] = view.readFloatLE(index * 4);
  return vector;
}

export function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length) throw new Error(`vector 차원이 다릅니다: ${left.length} != ${right.length}`);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}
