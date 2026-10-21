import { watch, type FSWatcher } from "node:fs";
import { basename } from "node:path";
import type { TomatoClient } from "./tomato/tomatoClient.ts";
import { TOMATO_LONG_CALL_TIMEOUT_MS } from "./tomato/tomatoClient.ts";
import type { Collection, EmbeddingReport, UpdateReport } from "./tomato/tomato.ts";

export const SYNC_DEBOUNCE_MS = 1500;
export const RECONCILE_INTERVAL_MS = 10 * 60 * 1000;
export const WATCHER_RETRY_MS = 60 * 1000;
const IGNORED_SEGMENTS = new Set([".git", "node_modules", "__pycache__", ".DS_Store", "Thumbs.db", "desktop.ini", ".Trash", "$RECYCLE.BIN"]);

export type CollectionSyncState = {
  syncing: boolean;
  dirty: boolean;
  embedding?: { completed: number; total: number };
  lastError?: string;
  lastReport?: UpdateReport;
  watching: boolean;
};

type Entry = {
  collection: Collection;
  watcher?: FSWatcher;
  debounce?: ReturnType<typeof setTimeout>;
  retry?: ReturnType<typeof setTimeout>;
  inFlight?: Promise<UpdateReport | undefined>;
  state: CollectionSyncState;
};

export type CollectionSyncTelemetry = {
  collection: string;
  startedAt: string;
  durationMs: number;
  report?: UpdateReport;
  embedding?: EmbeddingReport & { durationMs: number };
  error?: string;
};

/** fs.watch per collection → 1.5s debounce → single-flight sync (+dirty rerun) → background embed; 10-minute reconciliation. */
export class CollectionWatchers {
  private readonly entries = new Map<string, Entry>();
  private reconcileTimer?: ReturnType<typeof setInterval>;
  private readonly tomato: TomatoClient;
  private readonly onChange: (name: string, state: CollectionSyncState) => void;
  private readonly onSyncSettled: (result: CollectionSyncTelemetry) => void;
  private readonly log: (message: string) => void;

  constructor(
    tomato: TomatoClient,
    onChange: (name: string, state: CollectionSyncState) => void,
    onSyncSettled: (result: CollectionSyncTelemetry) => void = () => undefined,
    log: (message: string) => void = console.warn,
  ) {
    this.tomato = tomato;
    this.onChange = onChange;
    this.onSyncSettled = onSyncSettled;
    this.log = log;
  }

  start(collections: Collection[]): void {
    for (const collection of collections) this.watch(collection);
    this.reconcileTimer ??= setInterval(() => {
      for (const name of this.entries.keys()) void this.syncNow(name);
    }, RECONCILE_INTERVAL_MS);
  }

  stop(): void {
    clearInterval(this.reconcileTimer);
    this.reconcileTimer = undefined;
    for (const name of [...this.entries.keys()]) this.unwatch(name);
  }

  state(name: string): CollectionSyncState | undefined {
    return this.entries.get(name)?.state;
  }

  watch(collection: Collection): void {
    const entry = this.entries.get(collection.name) ?? { collection, state: { syncing: false, dirty: false, watching: false } };
    this.entries.set(collection.name, entry);
    this.openWatcher(entry);
  }

  unwatch(name: string): void {
    const entry = this.entries.get(name);
    if (!entry) return;
    entry.watcher?.close();
    clearTimeout(entry.debounce);
    clearTimeout(entry.retry);
    this.entries.delete(name);
  }

  private openWatcher(entry: Entry): void {
    entry.watcher?.close();
    try {
      // Symlinks are not followed; app data lives under userData, outside any collection root.
      const watcher = watch(entry.collection.path, { recursive: true }, (_event, filename) => {
        const name = typeof filename === "string" ? filename : "";
        if (name.split(/[\\/]/).some((segment) => IGNORED_SEGMENTS.has(segment) || segment.startsWith("._"))) return;
        this.requestSync(entry.collection.name);
      });
      watcher.on("error", (error) => {
        entry.state.watching = false;
        entry.state.lastError = `watcher error: ${error.message}`;
        this.emit(entry);
        watcher.close();
        clearTimeout(entry.retry);
        entry.retry = setTimeout(() => this.openWatcher(entry), WATCHER_RETRY_MS);
      });
      entry.watcher = watcher;
      entry.state.watching = true;
    } catch (error) {
      entry.state.watching = false;
      entry.state.lastError = `watcher failed: ${error instanceof Error ? error.message : String(error)}`;
      clearTimeout(entry.retry);
      entry.retry = setTimeout(() => this.openWatcher(entry), WATCHER_RETRY_MS);
    }
    this.emit(entry);
  }

  requestSync(name: string): void {
    const entry = this.entries.get(name);
    if (!entry) return;
    clearTimeout(entry.debounce);
    entry.debounce = setTimeout(() => void this.syncNow(name), SYNC_DEBOUNCE_MS);
  }

  /** Single-flight per collection: changes during a sync set dirty and trigger one more pass. */
  syncNow(name: string): Promise<UpdateReport | undefined> {
    const entry = this.entries.get(name);
    if (!entry) return Promise.resolve(undefined);
    if (entry.inFlight) {
      entry.state.dirty = true;
      return entry.inFlight;
    }
    entry.inFlight = this.runSync(entry).finally(() => {
      entry.inFlight = undefined;
      if (entry.state.dirty) {
        entry.state.dirty = false;
        void this.syncNow(name);
      }
    });
    return entry.inFlight;
  }

  private async runSync(entry: Entry): Promise<UpdateReport | undefined> {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    entry.state.syncing = true;
    entry.state.lastError = undefined;
    this.emit(entry);
    try {
      const report = await this.tomato.call("sync", [entry.collection.name], { timeoutMs: TOMATO_LONG_CALL_TIMEOUT_MS });
      entry.state.lastReport = report;
      if (report.failed.length) entry.state.lastError = `파싱/인덱싱 실패: ${basename(report.failed[0].path)} — ${report.failed[0].error}${report.failed.length > 1 ? ` (외 ${report.failed.length - 1}개)` : ""}`;
      entry.state.syncing = false;
      this.emit(entry);
      const embedding = await this.embed(entry);
      this.emitSync({ collection: entry.collection.name, startedAt, durationMs: Date.now() - started, report, embedding, error: entry.state.lastError });
      return report;
    } catch (error) {
      entry.state.syncing = false;
      entry.state.lastError = error instanceof Error ? error.message : String(error);
      this.emit(entry);
      this.log(`[collections] sync failed for ${entry.collection.name}: ${entry.state.lastError}`);
      this.emitSync({ collection: entry.collection.name, startedAt, durationMs: Date.now() - started, error: entry.state.lastError });
      return undefined;
    }
  }

  private async embed(entry: Entry): Promise<(EmbeddingReport & { durationMs: number }) | undefined> {
    const started = Date.now();
    try {
      const report = await this.tomato.call("embedMissing", [entry.collection.name], {
        timeoutMs: TOMATO_LONG_CALL_TIMEOUT_MS,
        onProgress: (completed, total) => {
          entry.state.embedding = { completed, total };
          this.emit(entry);
        },
      });
      entry.state.embedding = undefined;
      return { ...report, durationMs: Date.now() - started };
    } catch (error) {
      // Keyword search keeps working; hybrid becomes available after the next successful embed.
      const embeddingError = `embedding 실패: ${error instanceof Error ? error.message : String(error)}`;
      entry.state.lastError = entry.state.lastError ? `${entry.state.lastError} · ${embeddingError}` : embeddingError;
      return undefined;
    } finally {
      this.emit(entry);
    }
  }

  private emit(entry: Entry): void {
    this.onChange(entry.collection.name, { ...entry.state });
  }

  private emitSync(result: CollectionSyncTelemetry): void {
    try {
      this.onSyncSettled(result);
    } catch (error) {
      this.log(`[collections] sync telemetry failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
