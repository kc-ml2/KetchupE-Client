import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Memory, MemoryInput, MemoryKind } from "../../src/app-types/Agent.types.ts";
import { normalizeCjkForFts } from "../tomato/text.ts";

export const MEMORY_MAX_CHARS = 500;
const MEMORY_KINDS = new Set<MemoryKind>(["preference", "fact", "task"]);

function memoryKind(kind: MemoryKind): MemoryKind {
  if (!MEMORY_KINDS.has(kind)) throw new Error("지원하지 않는 기억 종류입니다.");
  return kind;
}

function memoryContent(content: string): string {
  const normalized = content.trim().slice(0, MEMORY_MAX_CHARS);
  if (!normalized) throw new Error("기억 내용을 입력하세요.");
  return normalized;
}

function replaceMemoryIndex(db: DatabaseSync, id: string, content?: string): void {
  db.prepare("DELETE FROM memories_fts WHERE id = ?").run(id);
  if (content) db.prepare("INSERT INTO memories_fts (id, content) VALUES (?, ?)").run(id, normalizeCjkForFts(content));
}

function toMemory(row: Record<string, unknown>): Memory {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    kind: row.kind as MemoryKind,
    content: String(row.content),
    status: row.status as Memory["status"],
    pinned: Number(row.pinned) === 1,
    createdAt: String(row.created_at),
  };
}

/** Model-proposed memories start pending; only the user confirms them. */
export function proposeMemory(
  db: DatabaseSync,
  input: { workspaceId: string; kind: MemoryKind; content: string; sourceId?: string; locator?: Record<string, unknown> },
): string {
  const id = randomUUID();
  db.prepare("INSERT INTO memories (id, workspace_id, kind, content, status, pinned, source_id, locator, created_at) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)")
    .run(id, input.workspaceId, input.kind, input.content.trim(), input.sourceId ?? null, input.locator ? JSON.stringify(input.locator) : null, new Date().toISOString());
  return id;
}

/** User-authored memories are confirmed immediately. */
export function addMemory(db: DatabaseSync, workspaceId: string, input: MemoryInput): string {
  const id = randomUUID();
  const content = memoryContent(input.content);
  const kind = memoryKind(input.kind);
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO memories (id, workspace_id, kind, content, status, pinned, created_at) VALUES (?, ?, ?, ?, 'confirmed', ?, ?)")
      .run(id, workspaceId, kind, content, input.pinned ? 1 : 0, new Date().toISOString());
    replaceMemoryIndex(db, id, content);
    db.exec("COMMIT");
    return id;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function updateMemory(db: DatabaseSync, id: string, input: MemoryInput): void {
  const row = db.prepare("SELECT status FROM memories WHERE id = ? AND status != 'deleted'").get(id) as { status: Memory["status"] } | undefined;
  if (!row) throw new Error("기억을 찾을 수 없습니다.");
  const content = memoryContent(input.content);
  const kind = memoryKind(input.kind);
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE memories SET kind = ?, content = ?, pinned = ? WHERE id = ?")
      .run(kind, content, input.pinned ? 1 : 0, id);
    replaceMemoryIndex(db, id, row.status === "confirmed" ? content : undefined);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function confirmMemory(db: DatabaseSync, id: string): void {
  const row = db.prepare("SELECT content FROM memories WHERE id = ? AND status = 'pending'").get(id) as { content: string } | undefined;
  if (!row) return;
  db.prepare("UPDATE memories SET status = 'confirmed' WHERE id = ?").run(id);
  replaceMemoryIndex(db, id, row.content);
}

export function deleteMemory(db: DatabaseSync, id: string): void {
  db.prepare("UPDATE memories SET status = 'deleted' WHERE id = ?").run(id);
  replaceMemoryIndex(db, id);
}

export function setMemoryPinned(db: DatabaseSync, id: string, pinned: boolean): void {
  db.prepare("UPDATE memories SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, id);
}

export function listMemories(db: DatabaseSync, workspaceId: string): Memory[] {
  return (db.prepare("SELECT * FROM memories WHERE workspace_id = ? AND status != 'deleted' ORDER BY pinned DESC, created_at DESC").all(workspaceId) as Record<string, unknown>[]).map(toMemory);
}

export function pinnedMemories(db: DatabaseSync, workspaceId: string): Memory[] {
  return (db.prepare("SELECT * FROM memories WHERE workspace_id = ? AND status = 'confirmed' AND pinned = 1 ORDER BY created_at").all(workspaceId) as Record<string, unknown>[]).map(toMemory);
}

export function searchConfirmedMemories(db: DatabaseSync, workspaceId: string, query: string, limit: number): Memory[] {
  const terms = normalizeCjkForFts(query).split(/\s+/).map((term) => term.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);
  if (!terms.length) return [];
  const expression = terms.map((term) => `"${term}"`).join(" OR ");
  try {
    const rows = db.prepare(`
      SELECT m.* FROM memories_fts f
      JOIN memories m ON m.id = f.id
      WHERE memories_fts MATCH ? AND m.workspace_id = ? AND m.status = 'confirmed'
      ORDER BY bm25(memories_fts) LIMIT ?
    `).all(expression, workspaceId, limit) as Record<string, unknown>[];
    return rows.map(toMemory);
  } catch {
    return [];
  }
}
