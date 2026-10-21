// @vitest-environment node
import { expect, it } from "vitest";
import { openAgentDb } from "../db/openAgentDb.ts";
import { createThread, ensureWorkspace, getRunAction, getRun } from "./store.ts";
import { WorkSourcesFlow, DAILY_CASH_ROUTE } from "./workSourcesFlow.ts";
import { WorkflowDispatcher } from "./workflows.ts";
import { buildRunTrace } from "./telemetry.ts";

it("persists input requests independently of the executor instance and excludes local runs from telemetry", async () => {
  const db = openAgentDb(":memory:");
  try {
    const workspace = ensureWorkspace(db); const thread = createThread(db, workspace.id);
    const flow = new WorkSourcesFlow(db, () => undefined);
    const dispatcher = new WorkflowDispatcher(db, [{ ...DAILY_CASH_ROUTE, kind: "daily_cash", start: (input) => flow.start(input, "daily_cash"), resume: (id, text) => flow.resume(id, text), cancel: (id) => flow.cancel(id) }], async () => "daily_cash");
    const result = await dispatcher.start({ threadId: thread.id, workspaceId: workspace.id, text: "오늘 자금일보 만들어줘" });
    expect(result.action?.type).toBe("work_sources");
    expect(getRunAction(db, result.runId)).toEqual(result.action);
    const restored = new WorkSourcesFlow(db, () => undefined);
    restored.resume(result.runId, "다시 선택");
    expect(() => restored.checkRequest(result.runId, result.action!.id)).toThrow("변경된 입력");
    expect(getRunAction(db, result.runId)?.id).not.toBe(result.action!.id);
    expect(buildRunTrace(db, result.runId, { userId: "user", identityKey: "key", contentMode: "internal_full", environment: "test", tenantId: "local", resource: {} })).toBeUndefined();
    restored.resume(result.runId, "취소");
    expect(getRun(db, result.runId).status).toBe("cancelled");
    expect(getRunAction(db, result.runId)).toBeUndefined();
  } finally { db.close(); }
});
