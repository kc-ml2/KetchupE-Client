// @vitest-environment node
import { expect, it } from "vitest";
import { openAgentDb } from "../db/openAgentDb.ts";
import { appendMessage, createRun, createThread, ensureWorkspace } from "./store.ts";
import { selectRoutingContext } from "./context.ts";

it("keeps bounded, ordered user and assistant context with workflow provenance from this thread only", () => {
  const db = openAgentDb(":memory:");
  try {
    const workspace = ensureWorkspace(db);
    const thread = createThread(db, workspace.id);
    const other = createThread(db, workspace.id);
    appendMessage(db, { threadId: other.id, runId: null, role: "assistant", content: "unrelated private content" });
    const runId = createRun(db, { threadId: thread.id, goal: "비용 집계", kind: "excel_work", retrievalProfile: "", policyProfile: "", answerProfile: "" });
    for (let i = 0; i < 7; i++) appendMessage(db, { threadId: thread.id, runId, role: i % 2 ? "assistant" : "user", content: `${i}: 비용 집계` });
    appendMessage(db, { threadId: thread.id, runId, role: "assistant", content: "결과 보고서.xlsx " + "x".repeat(2500) });
    const messages = selectRoutingContext(db, thread.id).recentMessages!;
    expect(messages).toHaveLength(6);
    expect(messages[0]).toEqual({ role: "user", content: "2: 비용 집계", runKind: "excel_work" });
    expect(messages.at(-1)).toMatchObject({ role: "assistant", runKind: "excel_work" });
    expect(messages.at(-1)!.content).toHaveLength(2000);
    expect(JSON.stringify(messages)).not.toContain("unrelated private content");
    expect(selectRoutingContext(db, other.id)).toEqual({ recentMessages: [{ role: "assistant", content: "unrelated private content" }] });
  } finally { db.close(); }
});
