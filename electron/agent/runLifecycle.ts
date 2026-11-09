import type { DatabaseSync } from "node:sqlite";
import { appendMessage, createRun, findOpenRun, getRun, setRunStatus } from "./store.ts";
import { AgentError } from "./contracts.ts";
import { TraceWriter } from "./trace.ts";

export type RunHandle = { runId: string; done: Promise<void> };

/** Executors adopt the request owned by the Harness; standalone callers still create their own run. */
export function startWorkflowRun(db: DatabaseSync, input: Parameters<typeof createRun>[1], existingId?: string): { runId: string; messageId: string } {
  if (existingId) {
    const run = getRun(db, existingId);
    if (run.threadId !== input.threadId || run.status !== "running" || findOpenRun(db, input.threadId)?.id !== existingId) {
      throw new AgentError("INTERNAL", "실행할 요청 상태가 변경되었습니다.");
    }
    const message = db.prepare("SELECT id FROM messages WHERE run_id = ? AND role = 'user' ORDER BY rowid DESC LIMIT 1").get(existingId) as { id: string } | undefined;
    if (!message) throw new AgentError("INTERNAL", "요청 메시지가 없습니다.");
    db.prepare("UPDATE runs SET kind = ?, retrieval_profile = ?, policy_profile = ?, answer_profile = ? WHERE id = ?")
      .run(input.kind ?? "agent", input.retrievalProfile, input.policyProfile, input.answerProfile, existingId);
    return { runId: existingId, messageId: message.id };
  }
  if (findOpenRun(db, input.threadId)) throw new AgentError("INTERNAL", "이 대화에 진행 중인 작업이 있습니다.");
  const runId = createRun(db, input);
  return { runId, messageId: appendMessage(db, { threadId: input.threadId, runId, role: "user", content: input.goal }).id };
}

/** Paused runs have no live controller, including after an app restart. */
export function cancelWaitingRun(db: DatabaseSync, runId: string, kind: string): boolean {
  const run = getRun(db, runId);
  if (run.kind !== kind || run.status !== "waiting_user") return false;
  setRunStatus(db, runId, "cancelled", "CANCELLED");
  new TraceWriter(db, runId).record("run.failed", "runtime", { code: "CANCELLED", message: "cancelled" });
  return true;
}
