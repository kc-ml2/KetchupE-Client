// Canvas persistence: whole-tree snapshots per edit (event sourcing) with a head pointer; undo/redo move the pointer.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ContractCanvas } from "../../../src/app-types/Canvas.types.ts";
import type { CanvasPayload, SourceRef } from "./tree.ts";

export type CanvasStatus = "drafting" | "editing" | "finalized";

export type CanvasRecord = {
  id: string;
  threadId: string;
  runId: string;
  canvasType: string;
  schemaVersion: string;
  title: string | null;
  instruction: string;
  status: CanvasStatus;
  headVersionId: string | null;
  references: CanvasReference[];
};

/** A grounding chunk kept with the canvas so regenerate and "open source" work after reload. */
export type CanvasReference = SourceRef & { path: string; content: string; kind?: "anchor" };

export type CanvasVersion = { id: string; canvasId: string; baseVersionId: string | null; op: unknown; payload: CanvasPayload; seq: number };

const now = () => new Date().toISOString();

function toCanvas(row: Record<string, unknown>): CanvasRecord {
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    runId: String(row.run_id),
    canvasType: String(row.canvas_type),
    schemaVersion: String(row.schema_version),
    title: row.title == null ? null : String(row.title),
    instruction: String(row.instruction),
    status: row.status as CanvasStatus,
    headVersionId: row.head_version_id == null ? null : String(row.head_version_id),
    references: JSON.parse(String(row.refs)) as CanvasReference[],
  };
}

function toVersion(row: Record<string, unknown>): CanvasVersion {
  return {
    id: String(row.id),
    canvasId: String(row.canvas_id),
    baseVersionId: row.base_version_id == null ? null : String(row.base_version_id),
    op: row.op == null ? null : JSON.parse(String(row.op)),
    payload: JSON.parse(String(row.payload)) as CanvasPayload,
    seq: Number(row.seq),
  };
}

export function createCanvas(
  db: DatabaseSync,
  input: { threadId: string; runId: string; canvasType: string; schemaVersion: string; title: string | null; instruction: string; references: CanvasReference[] },
): CanvasRecord {
  const id = randomUUID();
  const at = now();
  db.prepare(`
    INSERT INTO canvases (id, thread_id, run_id, canvas_type, schema_version, title, instruction, status, head_version_id, refs, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'drafting', NULL, ?, ?, ?)
  `).run(id, input.threadId, input.runId, input.canvasType, input.schemaVersion, input.title, input.instruction, JSON.stringify(input.references), at, at);
  return getCanvas(db, id);
}

export function getCanvas(db: DatabaseSync, id: string): CanvasRecord {
  const row = db.prepare("SELECT * FROM canvases WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`canvas not found: ${id}`);
  return toCanvas(row);
}

export function findCanvasByRun(db: DatabaseSync, runId: string): CanvasRecord | undefined {
  const row = db.prepare("SELECT * FROM canvases WHERE run_id = ?").get(runId) as Record<string, unknown> | undefined;
  return row ? toCanvas(row) : undefined;
}

export function writeVersion(db: DatabaseSync, canvas: CanvasRecord, payload: CanvasPayload, op: unknown): CanvasVersion {
  const id = randomUUID();
  const seqRow = db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM canvas_versions WHERE canvas_id = ?").get(canvas.id) as { seq: number };
  db.prepare("INSERT INTO canvas_versions (id, canvas_id, base_version_id, op, payload, created_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, canvas.id, canvas.headVersionId, op == null ? null : JSON.stringify(op), JSON.stringify(payload), now(), Number(seqRow.seq));
  setHead(db, canvas, id);
  return getVersion(db, id);
}

export function getVersion(db: DatabaseSync, id: string): CanvasVersion {
  const row = db.prepare("SELECT * FROM canvas_versions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`canvas version not found: ${id}`);
  return toVersion(row);
}

export function headVersion(db: DatabaseSync, canvas: CanvasRecord): CanvasVersion | undefined {
  return canvas.headVersionId ? getVersion(db, canvas.headVersionId) : undefined;
}

export function previousVersion(db: DatabaseSync, version: CanvasVersion | undefined): CanvasVersion | undefined {
  return version?.baseVersionId ? getVersion(db, version.baseVersionId) : undefined;
}

/** The latest version that was written on top of `version` (redo target). */
export function nextVersion(db: DatabaseSync, version: CanvasVersion | undefined): CanvasVersion | undefined {
  if (!version) return undefined;
  const row = db.prepare("SELECT * FROM canvas_versions WHERE canvas_id = ? AND base_version_id = ? ORDER BY seq DESC LIMIT 1").get(version.canvasId, version.id) as Record<string, unknown> | undefined;
  return row ? toVersion(row) : undefined;
}

export function setHead(db: DatabaseSync, canvas: CanvasRecord, versionId: string): void {
  db.prepare("UPDATE canvases SET head_version_id = ?, updated_at = ? WHERE id = ?").run(versionId, now(), canvas.id);
  canvas.headVersionId = versionId;
}

export function setCanvasStatus(db: DatabaseSync, canvas: CanvasRecord, status: CanvasStatus): void {
  db.prepare("UPDATE canvases SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), canvas.id);
  canvas.status = status;
}

export function setCanvasTitle(db: DatabaseSync, canvas: CanvasRecord, title: string | null): void {
  db.prepare("UPDATE canvases SET title = ?, updated_at = ? WHERE id = ?").run(title, now(), canvas.id);
  canvas.title = title;
}

/** Envelope + head payload in the renderer's ContractCanvas shape. */
export function serializeCanvas(canvas: CanvasRecord, version: CanvasVersion | undefined): ContractCanvas {
  const payload = version?.payload ?? { metadata: {}, sections: [], missing_terms: [] };
  return {
    schema_version: canvas.schemaVersion,
    canvas_type: canvas.canvasType,
    canvas_id: canvas.id,
    version_id: version?.id ?? "",
    base_version_id: version?.baseVersionId ?? null,
    status: canvas.status,
    title: canvas.title ?? undefined,
    metadata: {
      title: String(payload.metadata.title ?? canvas.title ?? ""),
      contract_type: String(payload.metadata.contract_type ?? ""),
      parties: (payload.metadata.parties ?? []).map((party) => ({ label: party.label, role: party.role ?? "", name: party.name ?? "", address: party.address ?? "", representative: party.representative ?? "" })),
    },
    sections: payload.sections as unknown as ContractCanvas["sections"],
    missing_terms: payload.missing_terms,
  };
}
