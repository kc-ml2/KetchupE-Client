import type { DatabaseSync } from "node:sqlite";
import { getRun, setRunStatus } from "./store.ts";
import { TraceWriter } from "./trace.ts";

export type RunHandle = { runId: string; done: Promise<void> };

/** Paused runs have no live controller, including after an app restart. */
export function cancelWaitingRun(db: DatabaseSync, runId: string, kind: string): boolean {
  const run = getRun(db, runId);
  if (run.kind !== kind || run.status !== "waiting_user") return false;
  setRunStatus(db, runId, "cancelled", "CANCELLED");
  new TraceWriter(db, runId).record("run.failed", "runtime", { code: "CANCELLED", message: "cancelled" });
  return true;
}
