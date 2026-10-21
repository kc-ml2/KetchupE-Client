import type { DatabaseSync } from "node:sqlite";
import type { PolicyTransition, TraceEvent, TraceStage, TraceEventType } from "./contracts.ts";

export class TraceWriter {
  private seq = 0;
  private readonly db: DatabaseSync;
  readonly runId: string;
  constructor(db: DatabaseSync, runId: string) {
    this.db = db;
    this.runId = runId;
    const row = db.prepare("SELECT MAX(seq) AS seq FROM trace_events WHERE run_id = ?").get(runId) as { seq: number | null };
    this.seq = Number(row.seq ?? 0);
  }

  record(
    type: TraceEventType,
    stage: TraceStage,
    payload: Record<string, unknown>,
    options: { parentSeq?: number; startedAt?: number; } = {},
  ): number {
    this.seq += 1;
    const startedAt = options.startedAt ?? Date.now();
    const durationMs = options.startedAt === undefined ? null : Date.now() - options.startedAt;
    this.db.prepare(`
      INSERT INTO trace_events (run_id, seq, parent_seq, type, stage, started_at, duration_ms, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(this.runId, this.seq, options.parentSeq ?? null, type, stage, new Date(startedAt).toISOString(), durationMs, JSON.stringify(payload));
    return this.seq;
  }
}

export function readTrace(db: DatabaseSync, runId: string): TraceEvent[] {
  const rows = db.prepare("SELECT * FROM trace_events WHERE run_id = ? ORDER BY seq").all(runId) as Record<string, unknown>[];
  return rows.map((row) => ({
    runId: String(row.run_id),
    seq: Number(row.seq),
    parentSeq: row.parent_seq == null ? undefined : Number(row.parent_seq),
    type: row.type as TraceEventType,
    stage: row.stage as TraceStage,
    startedAt: String(row.started_at),
    durationMs: row.duration_ms == null ? undefined : Number(row.duration_ms),
    payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
  }));
}

export function transitions(db: DatabaseSync, runId: string): PolicyTransition[] {
  return readTrace(db, runId)
    .filter((event) => event.type === "policy.decided" && event.payload.transition)
    .map((event) => event.payload.transition as PolicyTransition);
}
