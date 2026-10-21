// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openAgentDb } from "../db/openAgentDb.ts";
import { selectContext } from "./context.ts";
import { addMemory, deleteMemory, listMemories, setMemoryPinned, updateMemory } from "./memory.ts";
import { createThread, ensureWorkspace, setMemoryEnabled } from "./store.ts";

describe("workspace memory", () => {
  it("moves a legacy workspace instruction into pinned context", () => {
    const temporary = mkdtempSync(join(tmpdir(), "context-migration-"));
    const path = join(temporary, "agent.db");
    try {
      let db = openAgentDb(path);
      const workspace = ensureWorkspace(db);
      db.prepare("UPDATE workspaces SET active_task = ? WHERE id = ?").run("불확실하면 확인 질문하기", workspace.id);
      db.close();

      db = openAgentDb(path);
      const memories = listMemories(db, workspace.id);
      expect(memories).toMatchObject([{ kind: "preference", content: "불확실하면 확인 질문하기", status: "confirmed", pinned: true }]);
      expect(db.prepare("SELECT active_task FROM workspaces WHERE id = ?").get(workspace.id)).toMatchObject({ active_task: null });
      db.close();
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("adds, edits, pins, disables, and deletes a user memory", () => {
    const db = openAgentDb(":memory:");
    const workspace = ensureWorkspace(db);
    const thread = createThread(db, workspace.id);
    const id = addMemory(db, workspace.id, { kind: "preference", content: "  답변은 존댓말로  ", pinned: false });

    expect(listMemories(db, workspace.id)[0]).toMatchObject({ id, content: "답변은 존댓말로", status: "confirmed", pinned: false });

    updateMemory(db, id, { kind: "preference", content: "핵심만 존댓말로", pinned: false });
    setMemoryPinned(db, id, true);
    expect(selectContext(db, { workspaceId: workspace.id, threadId: thread.id, userGoal: "무관한 질문" }).memories)
      .toMatchObject([{ id, content: "핵심만 존댓말로" }]);

    setMemoryEnabled(db, workspace.id, false);
    expect(selectContext(db, { workspaceId: workspace.id, threadId: thread.id, userGoal: "존댓말" }).memories).toEqual([]);

    deleteMemory(db, id);
    expect(listMemories(db, workspace.id)).toEqual([]);
    db.close();
  });
});
