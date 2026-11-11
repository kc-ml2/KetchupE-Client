// @vitest-environment node
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { CollectionWatchers } from "./collectionWatchers.ts";
import type { TomatoClient } from "./tomato/tomatoClient.ts";

it("retries only the failed file and embeds only its source, preserving other failures", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "retry-file-")));
  await writeFile(join(root, "bad.txt"), "content");
  const call = vi.fn().mockResolvedValueOnce({ sourceId: "source-one" }).mockResolvedValueOnce({ embedded: 1 });
  const watchers = new CollectionWatchers({ call } as unknown as TomatoClient, vi.fn());
  watchers.watch({ name: "docs", path: root, ocr: "auto" });
  const state = watchers.state("docs")!;
  state.lastReport = { scanned: 2, updated: 0, unchanged: 0, removed: 0, pipelineFingerprint: "test", failed: [{ path: join(root, "bad.txt"), error: "failed" }, { path: join(root, "other.txt"), error: "other" }] };
  try {
    await watchers.retryFile("docs", "bad.txt");
    expect(call.mock.calls.map(([method]) => method)).toEqual(["ingestFile", "embedMissing"]);
    expect(call.mock.calls[0][1]).toEqual([join(root, "bad.txt"), "docs", "bad.txt", "auto"]);
    expect(call.mock.calls[1][1]).toEqual(["docs", "source-one"]);
    expect(state.lastReport.failed).toEqual([{ path: join(root, "other.txt"), error: "other" }]);
    expect(state.syncing).toBe(false);
    await expect(watchers.retryFile("docs", "bad.txt")).rejects.toThrow("실패한 파일만");
    await expect(watchers.retryFile("docs", "../outside")).rejects.toThrow();
  } finally { watchers.stop(); await rm(root, { recursive: true, force: true }); }
});

it("publishes pending before analysis starts", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "analysis-state-")));
  const phases: string[] = [];
  const call = vi.fn().mockResolvedValue({ scanned: 0, updated: 0, unchanged: 0, removed: 0, failed: [], pipelineFingerprint: "test" });
  const watchers = new CollectionWatchers({ call } as unknown as TomatoClient, (_name, state) => { phases.push(state.syncing ? "analyzing" : state.pending ? "pending" : "idle"); });
  try {
    watchers.watch({ name: "docs", path: root });
    watchers.requestSync("docs");
    expect(watchers.state("docs")?.pending).toBe(true);
    await watchers.syncNow("docs");
    expect(phases.indexOf("pending")).toBeLessThan(phases.indexOf("analyzing"));
    expect(watchers.state("docs")?.pending).toBe(false);
  } finally { watchers.stop(); await rm(root, { recursive: true, force: true }); }
});
