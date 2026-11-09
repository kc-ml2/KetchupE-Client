// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openAgentDb } from "../db/openAgentDb.ts";
import { Harness, type HarnessOptions } from "./harness.ts";
import { WorkflowHandoff, type AgentWorkflow } from "./workflows.ts";
import { createThread, ensureWorkspace, getRun, loadThread, setRunStatus } from "./store.ts";
import { startWorkflowRun } from "./runLifecycle.ts";
import { readTrace, TraceWriter } from "./trace.ts";
import type { AgentStreamEvent } from "../../src/app-types/Agent.types.ts";

let db: DatabaseSync;
let workspaceId: string;
beforeEach(() => { db = openAgentDb(":memory:"); workspaceId = ensureWorkspace(db).id; });
afterEach(() => { db.close(); });
const settings = () => ({ baseURL: "https://example.test", modelAlias: "clef" });
const input = (text = "hello", mode?: string) => ({ workspaceId, threadId: createThread(db, workspaceId).id, text, mode });
function workflow(id: string, kind = id, work?: (runId: string) => Promise<void>): AgentWorkflow {
  return { id, kind, description: `${id} task`,
    start: vi.fn((request) => {
      const { runId } = startWorkflowRun(db, { threadId: request.threadId, goal: request.text, kind, retrievalProfile: id, policyProfile: id, answerProfile: id }, request.runId);
      return { runId, done: work ? work(runId) : Promise.resolve().then(() => { setRunStatus(db, runId, "waiting_user"); }) };
    }),
    resume: vi.fn((runId) => { setRunStatus(db, runId, "completed"); return { runId, done: Promise.resolve() }; }),
    cancel: vi.fn((runId) => { setRunStatus(db, runId, "cancelled", "CANCELLED"); }),
  };
}
function harness(flows: AgentWorkflow[], extra: Partial<HarnessOptions> = {}) {
  return new Harness({ db, workflows: flows, route: async () => flows[0].id, routingSettings: settings, ...extra });
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("request Harness", () => {
  it("creates one cancellable request before routing and preserves its message across automatic handoff", async () => {
    const events: AgentStreamEvent[] = [];
    const chat = workflow("chat", "chat", async () => { throw new WorkflowHandoff("rag", "private evidence required"); });
    const rag = workflow("rag", "agent");
    const agent = harness([chat, rag], { emit: (event) => events.push(event) });
    const request = input(); const result = agent.start(request);
    expect(result.kind).toBe("routing");
    expect(getRun(db, result.runId).status).toBe("running");
    expect(chat.start).not.toHaveBeenCalled();
    await agent.drain(result.runId);
    expect(getRun(db, result.runId)).toMatchObject({ kind: "agent", status: "waiting_user" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM runs").get()?.n).toBe(1);
    expect(loadThread(db, request.threadId).messages).toHaveLength(1);
    expect(events.filter((event) => event.type === "workflow_changed").map((event) => event.payload)).toMatchObject([{ workflow: "chat" }, { workflow: "rag" }]);
    expect(readTrace(db, result.runId).filter((event) => event.type === "model.completed")[0].payload).toMatchObject({ purpose: "routing", workflow: "chat" });
  });

  it("rejects duplicate starts before asynchronous authorization and permits independent threads", async () => {
    let authorize!: () => void;
    const agent = harness([workflow("chat")], { authorizeThread: () => new Promise<void>((resolve) => { authorize = resolve; }) });
    const request = input(); const first = agent.start(request);
    expect(() => agent.start(request)).toThrow();
    await tick(); authorize(); await agent.drain(first.runId);
    const second = agent.start(input()); await tick(); authorize(); await agent.drain(second.runId);
    expect(second.runId).not.toBe(first.runId);
  });

  it("cancels routing, ignores a late route and records the routing duration", async () => {
    let finish!: (id: string) => void;
    const flow = workflow("chat");
    const agent = harness([flow], { route: () => new Promise<string>((resolve) => { finish = resolve; }) });
    const { runId } = agent.start(input()); await tick();
    await agent.cancel(runId); finish("chat"); await agent.drain(runId);
    expect(flow.start).not.toHaveBeenCalled();
    expect(getRun(db, runId).status).toBe("cancelled");
    expect(readTrace(db, runId).find((event) => event.type === "model.completed")?.payload.code).toBe("CANCELLED");
  });

  it("does not launch workflows after authorization or routing failures", async () => {
    for (const failure of ["authorization", "routing"]) {
      const flow = workflow("chat");
      const agent = harness([flow], failure === "authorization" ? { authorizeThread: async () => { throw new Error("denied"); } } : { route: async () => { throw new Error("offline"); } });
      const { runId } = agent.start(input()); await agent.drain(runId);
      expect(getRun(db, runId).status).toBe("failed"); expect(flow.start).not.toHaveBeenCalled();
    }
  });

  it("explicit mode and command skip routing; waiting replies resume their persisted owner", async () => {
    const chat = workflow("chat"), rag = workflow("rag", "agent");
    const route = vi.fn(async () => "chat"); const agent = harness([chat, rag], { route });
    for (const request of [input("question", "rag"), input("$rag question")]) {
      const { runId } = agent.start(request); await agent.drain(runId);
      agent.start({ ...request, text: "answer", mode: "chat" }); await agent.drain(runId);
      expect(rag.resume).toHaveBeenCalledWith(runId, "answer");
    }
    expect(route).not.toHaveBeenCalled();
    const invalid = input("hello", "missing"); expect(() => agent.start(invalid)).toThrow("등록되지 않은");
    expect(() => agent.start({ ...input(), workspaceId: "other" })).toThrow("작업 공간");
    expect(() => agent.start(input("  "))).toThrow("요청 내용");
  });

  it("bounds handoffs and rejects loops, unknown targets and ordinary failures without fallback", async () => {
    for (const target of ["chat", "missing", "rag"]) {
      const chat = workflow("chat", "chat", async () => { throw new WorkflowHandoff(target, "wrong workflow"); });
      const rag = workflow("rag", "agent", async () => { throw new WorkflowHandoff("chat", "back"); });
      const agent = harness([chat, rag]); const { runId } = agent.start(input()); await agent.drain(runId);
      expect(getRun(db, runId).status).toBe("failed"); expect(chat.start).toHaveBeenCalledOnce();
    }
    const flows = ["a", "b", "c", "d"].map((id, index, ids) => workflow(id, id, async () => { throw new WorkflowHandoff(ids[index + 1], "next"); }));
    const agent = harness(flows); const { runId } = agent.start(input()); await agent.drain(runId);
    expect(getRun(db, runId).errorCode).toBe("BUDGET_EXCEEDED"); expect(flows[3].start).not.toHaveBeenCalled();
    const broken = workflow("broken", "broken", async () => { throw new Error("timeout"); });
    const fallback = workflow("fallback"); const other = harness([broken, fallback]); const result = other.start(input()); await other.drain(result.runId);
    expect(fallback.start).not.toHaveBeenCalled();
  });

  it("drains an active executor before user correction, clears stale input and keeps monotonic events", async () => {
    let finish!: () => void; let drain!: () => void;
    const events: AgentStreamEvent[] = [];
    const old = workflow("doc", "canvas", () => new Promise<void>((resolve) => { finish = resolve; }));
    const next = workflow("excel_work");
    old.cancel = vi.fn(async (id) => { setRunStatus(db, id, "cancelled"); await new Promise<void>((resolve) => { drain = resolve; }); finish(); });
    const agent = harness([old, next], { emit: (event) => events.push(event), route: async (_text, _routes, _signal, context) => context.currentWorkflow ? "excel_work" : "doc" });
    const request = input(); const { runId } = agent.start(request); await tick();
    agent.forward({ runId, seq: 99, type: "text_delta", payload: { text: "old" } });
    await agent.switchWorkflow(runId, "엑셀 집계가 필요해");
    expect(() => agent.assertAvailable(runId)).toThrow("전환"); expect(next.start).not.toHaveBeenCalled();
    drain(); await agent.drain(runId);
    expect(next.start).toHaveBeenCalledOnce(); expect(getRun(db, runId)).toMatchObject({ kind: "excel_work", status: "waiting_user" });
    expect(loadThread(db, request.threadId).messages).toHaveLength(2);
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
    expect(events.some((event) => event.type === "failed")).toBe(false);
  });

  it("cancels during a handoff without starting the replacement", async () => {
    let release!: () => void;
    const old = workflow("chat"), next = workflow("doc", "canvas");
    old.cancel = vi.fn(async (id) => { setRunStatus(db, id, "cancelled"); await new Promise<void>((resolve) => { release = resolve; }); });
    const agent = harness([old, next]); const { runId } = agent.start(input()); await agent.drain(runId);
    await agent.switchWorkflow(runId, "문서로 작성", "doc");
    const cancelling = agent.cancel(runId); release(); await cancelling; await agent.drain(runId);
    expect(next.start).not.toHaveBeenCalled(); expect(getRun(db, runId).status).toBe("cancelled");
  });

  it("restores waiting ownership and refuses switching after original-file writes begin", async () => {
    const old = workflow("daily_cash"), next = workflow("excel_work");
    const first = harness([old, next]); const { runId } = first.start(input()); await first.drain(runId);
    const restored = harness([old, next]);
    new TraceWriter(db, runId).record("workflow.effect_started", "runtime", { localOnly: true });
    await expect(restored.switchWorkflow(runId, "변경", "excel_work")).rejects.toThrow("원본 파일");
    expect(old.cancel).not.toHaveBeenCalled(); restored.resume(runId, "확인"); await restored.drain(runId);
    expect(getRun(db, runId).status).toBe("completed");
  });

  it("allocates trace sequences across overlapping writers", () => {
    const flow = workflow("chat"); const result = flow.start(input());
    const first = new TraceWriter(db, result.runId), second = new TraceWriter(db, result.runId);
    expect(first.record("workflow.selected", "runtime", {})).toBe(1);
    expect(second.record("workflow.selected", "runtime", {})).toBe(2);
    expect(first.record("workflow.selected", "runtime", {})).toBe(3);
    return result.done;
  });

  it("validates registrations and stops without leaving work running", async () => {
    expect(() => harness([])).toThrow("required");
    expect(() => harness([workflow("chat"), workflow("chat")])).toThrow("duplicate");
    expect(() => harness([workflow("chat", "same"), workflow("doc", "same")])).toThrow("duplicate");
    const flow = workflow("chat"); const agent = harness([flow]); const { runId } = agent.start(input());
    await agent.stop(); expect(getRun(db, runId).status).toBe("cancelled"); expect(() => agent.start(input())).toThrow("signed out");
  });
});
