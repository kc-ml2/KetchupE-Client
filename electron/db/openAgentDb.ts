import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeCjkForFts } from "../tomato/text.ts";
import { AGENT_SCHEMA } from "./schema.ts";

function migrateWorkspaceInstructions(db: DatabaseSync): void {
  const rows = db.prepare("SELECT id, active_task FROM workspaces WHERE active_task IS NOT NULL AND trim(active_task) != ''").all() as Array<{ id: string; active_task: string }>;
  if (!rows.length) return;
  db.exec("BEGIN");
  try {
    for (const row of rows) {
      const memoryId = `legacy-workspace-instruction:${row.id}`;
      db.prepare("INSERT INTO memories (id, workspace_id, kind, content, status, pinned, created_at) VALUES (?, ?, 'preference', ?, 'confirmed', 1, ?) ON CONFLICT(id) DO UPDATE SET content = excluded.content, status = 'confirmed', pinned = 1")
        .run(memoryId, row.id, row.active_task.trim(), new Date().toISOString());
      db.prepare("DELETE FROM memories_fts WHERE id = ?").run(memoryId);
      db.prepare("INSERT INTO memories_fts (id, content) VALUES (?, ?)").run(memoryId, normalizeCjkForFts(row.active_task));
    }
    db.prepare("UPDATE workspaces SET active_task = NULL WHERE active_task IS NOT NULL AND trim(active_task) != ''").run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function openAgentDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(AGENT_SCHEMA);
  // runs.kind distinguishes agent runs from canvas (document authoring) runs.
  const columns = (db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map((column) => column.name);
  if (!columns.includes("kind")) db.exec("ALTER TABLE runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'agent'");
  const workspaceColumns = (db.prepare("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>).map((column) => column.name);
  if (!workspaceColumns.includes("memory_enabled")) db.exec("ALTER TABLE workspaces ADD COLUMN memory_enabled INTEGER NOT NULL DEFAULT 1");
  const messageColumns = (db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((column) => column.name);
  if (!messageColumns.includes("applied_context")) db.exec("ALTER TABLE messages ADD COLUMN applied_context TEXT");
  migrateWorkspaceInstructions(db);
  // App restart: a run cannot still be running; only waiting_user resumes.
  db.prepare("UPDATE runs SET status = 'cancelled', error_code = 'CANCELLED', finished_at = ? WHERE status = 'running'").run(new Date().toISOString());
  return db;
}
