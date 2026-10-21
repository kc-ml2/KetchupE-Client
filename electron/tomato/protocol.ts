import type { ChunkRecord, Collection, CollectionStatus, EmbeddingReport, IngestedSource, OcrMode, SearchMode, SourceRecord, TomatoSearch, UpdateReport } from "./tomato.ts";

/** Request/response protocol between the main process and the Tomato utility process. */
export type TomatoMethods = {
  registerCollection: { args: [folder: string, name: string, ocr?: OcrMode]; result: Collection };
  remove: { args: [name: string]; result: void };
  listCollections: { args: []; result: Collection[] };
  sync: { args: [collection?: string]; result: UpdateReport };
  embedMissing: { args: [collection?: string]; result: EmbeddingReport };
  search: { args: [query: string, options: { collections: string[]; limit?: number; mode?: SearchMode }]; result: TomatoSearch };
  getNeighbors: { args: [chunkId: string, before: number, after: number]; result: ChunkRecord[] };
  getChunks: { args: [chunkIds: string[]]; result: ChunkRecord[] };
  listSources: { args: [collections: string[]]; result: SourceRecord[] };
  getSourceChunks: { args: [sourceId: string]; result: ChunkRecord[] };
  ingestFile: { args: [path: string, collection: string, relativePath: string, ocr?: OcrMode]; result: IngestedSource };
  status: { args: []; result: CollectionStatus[] };
  collectionFingerprint: { args: [name: string]; result: string };
};

export type TomatoMethodName = keyof TomatoMethods;

export type WorkerRequest = { [K in TomatoMethodName]: { id: number; method: K; args: TomatoMethods[K]["args"] } }[TomatoMethodName];

export type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }
  | { id: number; progress: { completed: number; total: number } };
