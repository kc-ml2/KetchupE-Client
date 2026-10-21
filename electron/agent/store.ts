import type { RunAction } from "../../src/app-types/Agent.types.ts";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AppliedContext, CitationSummary, InteractionKind, MessagePage, MessageRecord, RunKind, RunStatus, ThreadSummary, WorkspaceSummary } from "../../src/app-types/Agent.types.ts";

export const DEFAULT_WORKSPACE_ID = "default";
export const THREAD_TITLE_MAX_CHARS = 40;
export const THREAD_PAGE_SIZE = 50;

const now = () => new Date().toISOString();

export function ensureWorkspace(db: DatabaseSync, id = DEFAULT_WORKSPACE_ID): WorkspaceSummary {
  db.prepare("INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES (?, ?, ?)").run(id, "기본 작업 공간", now());
  return getWorkspace(db, id);
}

export function getWorkspace(db: DatabaseSync, id: string): WorkspaceSummary {
  const row = db.prepare("SELECT id, name, memory_enabled FROM workspaces WHERE id = ?").get(id) as
    | { id: string; name: string; memory_enabled: number }
    | undefined;
  if (!row) throw new Error(`workspace not found: ${id}`);
  return { id: row.id, name: row.name, memoryEnabled: row.memory_enabled === 1 };
}

export function setMemoryEnabled(db: DatabaseSync, workspaceId: string, enabled: boolean): void {
  db.prepare("UPDATE workspaces SET memory_enabled = ? WHERE id = ?").run(enabled ? 1 : 0, workspaceId);
}

export function setCollectionActive(db: DatabaseSync, workspaceId: string, collection: string, active: boolean): void {
  db.prepare(`
    INSERT INTO workspace_collections (workspace_id, collection, active) VALUES (?, ?, ?)
    ON CONFLICT(workspace_id, collection) DO UPDATE SET active = excluded.active
  `).run(workspaceId, collection, active ? 1 : 0);
}

/** Collections default to active until explicitly turned off. */
export function inactiveCollections(db: DatabaseSync, workspaceId: string): Set<string> {
  const rows = db.prepare("SELECT collection FROM workspace_collections WHERE workspace_id = ? AND active = 0").all(workspaceId) as Array<{ collection: string }>;
  return new Set(rows.map((row) => row.collection));
}

function toThread(row: Record<string, unknown>): ThreadSummary {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    title: String(row.title),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function createThread(db: DatabaseSync, workspaceId: string): ThreadSummary {
  const id = randomUUID();
  const at = now();
  db.prepare("INSERT INTO threads (id, workspace_id, title, created_at, updated_at) VALUES (?, ?, '', ?, ?)").run(id, workspaceId, at, at);
  return { id, workspaceId, title: "", createdAt: at, updatedAt: at };
}

export function listThreads(db: DatabaseSync, workspaceId: string): ThreadSummary[] {
  return (db.prepare("SELECT * FROM threads WHERE workspace_id = ? ORDER BY updated_at DESC, created_at DESC").all(workspaceId) as Record<string, unknown>[]).map(toThread);
}

export function getThread(db: DatabaseSync, threadId: string): ThreadSummary {
  const row = db.prepare("SELECT * FROM threads WHERE id = ?").get(threadId) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`thread not found: ${threadId}`);
  return toThread(row);
}

export function renameThread(db: DatabaseSync, threadId: string, title: string): void {
  db.prepare("UPDATE threads SET title = ? WHERE id = ?").run(title.trim().slice(0, 120), threadId);
}

export function deleteThread(db: DatabaseSync, threadId: string): void {
  if (findOpenRun(db, threadId)) throw new Error("진행 중인 작업을 중단한 뒤 대화를 삭제하세요.");
  db.prepare("DELETE FROM threads WHERE id = ?").run(threadId);
}

function messageCitations(db: DatabaseSync, runId: string | null, content: string): CitationSummary[] {
  if (!runId) return [];
  const ids = [...new Set([...content.matchAll(/\[\[(e\d+)\]\]/g)].map((match) => match[1]))];
  if (!ids.length) return [];
  const rows = db.prepare("SELECT evidence_id, title, locator FROM citations WHERE run_id = ?").all(runId) as Array<{ evidence_id: string; title: string; locator: string }>;
  const byId = new Map(rows.map((row) => [row.evidence_id, row]));
  return ids.flatMap((evidenceId) => {
    const row = byId.get(evidenceId);
    if (!row) return [];
    const locator = JSON.parse(row.locator) as { pageStart?: number };
    return [{ evidenceId, title: row.title, breadcrumb: [], page: locator.pageStart }];
  });
}

function toMessage(db: DatabaseSync, row: Record<string, unknown>): MessageRecord {
  const runId = row.run_id == null ? null : String(row.run_id);
  const content = String(row.content);
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    runId,
    role: row.role as MessageRecord["role"],
    content,
    citations: messageCitations(db, runId, content),
    appliedContext: row.applied_context ? JSON.parse(String(row.applied_context)) as AppliedContext : { memories: [] },
    createdAt: String(row.created_at),
  };
}

/** Latest page in chronological order; `beforeMessageId` pages backwards. Insertion order (rowid) breaks same-millisecond ties. */
export function loadThread(db: DatabaseSync, threadId: string, beforeMessageId?: string, limit = THREAD_PAGE_SIZE): MessagePage {
  const rows = (beforeMessageId
    ? db.prepare(`
        SELECT * FROM messages WHERE thread_id = ? AND rowid < (SELECT rowid FROM messages WHERE id = ?)
        ORDER BY rowid DESC LIMIT ?
      `).all(threadId, beforeMessageId, limit + 1)
    : db.prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY rowid DESC LIMIT ?").all(threadId, limit + 1)) as Record<string, unknown>[];
  const hasMore = rows.length > limit;
  return { messages: rows.slice(0, limit).reverse().map((row) => toMessage(db, row)), hasMore };
}

export function recentMessages(db: DatabaseSync, threadId: string, limit: number, excludeId?: string): MessageRecord[] {
  const rows = db.prepare("SELECT * FROM messages WHERE thread_id = ? AND id != ? ORDER BY rowid DESC LIMIT ?")
    .all(threadId, excludeId ?? "", limit) as Record<string, unknown>[];
  return rows.reverse().map((row) => toMessage(db, row));
}

export function appendMessage(db: DatabaseSync, input: { threadId: string; runId: string | null; role: MessageRecord["role"]; content: string; appliedContext?: AppliedContext }): MessageRecord {
  const id = randomUUID();
  const at = now();
  const appliedContext = input.appliedContext ?? { memories: [] };
  db.prepare("INSERT INTO messages (id, thread_id, run_id, role, content, applied_context, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, input.threadId, input.runId, input.role, input.content, input.appliedContext ? JSON.stringify(appliedContext) : null, at);
  db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(at, input.threadId);
  if (input.role === "user") {
    db.prepare("UPDATE threads SET title = ? WHERE id = ? AND title = ''").run(input.content.trim().slice(0, THREAD_TITLE_MAX_CHARS), input.threadId);
  }
  return { id, threadId: input.threadId, runId: input.runId, role: input.role, content: input.content, citations: [], appliedContext, createdAt: at };
}

export type { RunKind } from "../../src/app-types/Agent.types.ts";

export type RunRecord = {
  id: string;
  threadId: string;
  goal: string;
  status: RunStatus;
  errorCode: string | null;
  kind: RunKind;
};

export function createRun(
  db: DatabaseSync,
  input: { threadId: string; goal: string; retrievalProfile: string; policyProfile: string; answerProfile: string; kind?: RunKind },
): string {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO runs (id, thread_id, goal, status, retrieval_profile, policy_profile, answer_profile, created_at, kind)
    VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?)
  `).run(id, input.threadId, input.goal, input.retrievalProfile, input.policyProfile, input.answerProfile, now(), input.kind ?? "agent");
  return id;
}

export function getRun(db: DatabaseSync, runId: string): RunRecord {
  const row = db.prepare("SELECT id, thread_id, goal, status, error_code, kind FROM runs WHERE id = ?").get(runId) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`run not found: ${runId}`);
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    goal: String(row.goal),
    status: row.status as RunStatus,
    errorCode: row.error_code == null ? null : String(row.error_code),
    kind: (row.kind as RunKind) ?? "agent",
  };
}

export function findOpenRun(db: DatabaseSync, threadId: string): RunRecord | undefined {
  const row = db.prepare("SELECT id FROM runs WHERE thread_id = ? AND status IN ('running', 'waiting_user')").get(threadId) as { id: string } | undefined;
  return row ? getRun(db, row.id) : undefined;
}

export function setRunStatus(db: DatabaseSync, runId: string, status: RunStatus, errorCode?: string): void {
  const finished = status === "running" || status === "waiting_user" ? null : now();
  db.prepare("UPDATE runs SET status = ?, error_code = ?, finished_at = ? WHERE id = ?").run(status, errorCode ?? null, finished, runId);
}

export function recordInteraction(db: DatabaseSync, runId: string, kind: InteractionKind, metadata?: Record<string, unknown>): void {
  db.prepare("INSERT INTO interaction_events (run_id, kind, created_at, metadata) VALUES (?, ?, ?, ?)")
    .run(runId, kind, now(), metadata ? JSON.stringify(metadata) : null);
}

export function getRunAction(db: DatabaseSync, runId: string): RunAction | undefined {
  const row = db.prepare("SELECT action FROM run_actions JOIN runs ON runs.id = run_actions.run_id WHERE run_id = ? AND runs.status = 'waiting_user'").get(runId) as { action: string } | undefined;
  return row ? JSON.parse(row.action) as RunAction : undefined;
}
