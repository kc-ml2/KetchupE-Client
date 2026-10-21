import { utilityProcess, type UtilityProcess } from "electron";
import { AgentError } from "../agent/contracts.ts";
import type { TomatoMethodName, TomatoMethods, WorkerRequest, WorkerResponse } from "./protocol.ts";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; onProgress?: (completed: number, total: number) => void; timer?: ReturnType<typeof setTimeout> };

export const TOMATO_CALL_TIMEOUT_MS = 30_000;
export const TOMATO_LONG_CALL_TIMEOUT_MS = 60 * 60 * 1000;

/** Main-process handle to the Tomato utility process. Restarts the worker lazily after a crash; in-flight calls fail with TOOL_UNAVAILABLE. */
export class TomatoClient {
  private child: UtilityProcess | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly workerPath: string;
  private readonly home: string;
  private readonly log: (message: string) => void;

  constructor(workerPath: string, home: string, log: (message: string) => void = console.warn) {
    this.workerPath = workerPath;
    this.home = home;
    this.log = log;
  }

  private ensureChild(): UtilityProcess {
    if (this.child) return this.child;
    const child = utilityProcess.fork(this.workerPath, [this.home], { serviceName: "ketchupe-tomato", stdio: "inherit" });
    child.on("message", (message: WorkerResponse) => this.onMessage(message));
    child.on("exit", (code) => {
      this.log(`[tomato] worker exited with code ${code}`);
      this.child = undefined;
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new AgentError("TOOL_UNAVAILABLE", "tomato worker exited"));
        this.pending.delete(id);
      }
    });
    this.child = child;
    return child;
  }

  private onMessage(message: WorkerResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if ("progress" in message) {
      pending.onProgress?.(message.progress.completed, message.progress.total);
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error));
  }

  call<K extends TomatoMethodName>(
    method: K,
    args: TomatoMethods[K]["args"],
    options: { timeoutMs?: number; onProgress?: (completed: number, total: number) => void } = {},
  ): Promise<TomatoMethods[K]["result"]> {
    const child = this.ensureChild();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AgentError("TOOL_TIMEOUT", `tomato ${method} timed out`));
      }, options.timeoutMs ?? TOMATO_CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, onProgress: options.onProgress, timer });
      child.postMessage({ id, method, args } as WorkerRequest);
    });
  }

  search(query: string, options: { collections: string[]; limit?: number; mode?: "keyword" | "semantic" | "hybrid" }) {
    return this.call("search", [query, options]);
  }

  getNeighbors(chunkId: string, before: number, after: number) {
    return this.call("getNeighbors", [chunkId, before, after]);
  }

  getChunks(chunkIds: string[]) {
    return this.call("getChunks", [chunkIds]);
  }

  listSources(collections: string[]) {
    return this.call("listSources", [collections]);
  }

  getSourceChunks(sourceId: string) {
    return this.call("getSourceChunks", [sourceId]);
  }

  ingestFile(path: string, collection: string, relativePath: string) {
    return this.call("ingestFile", [path, collection, relativePath, "auto"], { timeoutMs: TOMATO_LONG_CALL_TIMEOUT_MS });
  }

  collectionFingerprint(name: string) {
    return this.call("collectionFingerprint", [name]);
  }

  stop(): void {
    this.child?.kill();
    this.child = undefined;
  }
}
