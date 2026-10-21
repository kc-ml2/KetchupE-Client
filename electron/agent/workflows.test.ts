// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { openAgentDb } from "../db/openAgentDb.ts";
import { createRun, createThread, ensureWorkspace, getRun, setRunStatus } from "./store.ts";
import { cancelWaitingRun } from "./runLifecycle.ts";
import { readTrace } from "./trace.ts";
import { WorkflowDispatcher, type AgentWorkflow } from "./workflows.ts";

const db = openAgentDb(":memory:");
const workspace = ensureWorkspace(db);
afterEach(() => vi.restoreAllMocks());

function workflow(id: string, kind = id): AgentWorkflow {
  return {
    id, kind, description: `${id} task`, matches: (text) => text.includes(id),
    start: vi.fn((input) => ({ runId: createRun(db, { threadId: input.threadId, goal: input.text, retrievalProfile: id, policyProfile: id, answerProfile: id, kind }), done: Promise.resolve() })),
    resume: vi.fn((runId) => { setRunStatus(db, runId, "running"); return { runId, done: Promise.resolve() }; }),
    cancel: vi.fn((runId) => { setRunStatus(db, runId, "cancelled", "CANCELLED"); }),
  };
}

function input(text = "hello", mode?: string) {
  return { workspaceId: workspace.id, threadId: createThread(db, workspace.id).id, text, mode };
}

describe("workflow dispatcher", () => {
  it("starts a third workflow without hardcoded branches and cancels only its owner", async () => {
    const flows = [workflow("chat", "agent"), workflow("doc", "canvas"), workflow("summary")];
    const route = vi.fn(async () => "summary");
    const started = vi.fn();
    const dispatcher = new WorkflowDispatcher(db, flows, route, started);
    const result = await dispatcher.start(input("summary"));
    expect(result.kind).toBe("summary");
    expect(getRun(db, result.runId).kind).toBe("summary");
    expect(route.mock.calls[0]).toHaveLength(3);
    expect(started).toHaveBeenCalledWith(result.runId);
    dispatcher.cancel(result.runId);
    expect(flows[2].cancel).toHaveBeenCalledWith(result.runId);
    expect(flows[0].cancel).not.toHaveBeenCalled();
    expect(flows[1].cancel).not.toHaveBeenCalled();
    dispatcher.cancel(result.runId);
    expect(flows[2].cancel).toHaveBeenCalledTimes(1);
  });

  it("forced modes skip routing; waiting runs resume their owner even with a different mode", async () => {
    const flows = [workflow("chat", "agent"), workflow("summary")];
    const route = vi.fn(async () => "chat");
    const dispatcher = new WorkflowDispatcher(db, flows, route);
    const request = input("summarize", "summary");
    const first = await dispatcher.start(request);
    expect(route).not.toHaveBeenCalled();
    setRunStatus(db, first.runId, "waiting_user");
    expect(await dispatcher.start({ ...request, text: "yes", mode: "chat" })).toEqual(first);
    expect(flows[1].resume).toHaveBeenCalledWith(first.runId, "yes");
    expect(flows[0].start).not.toHaveBeenCalled();
    expect(() => dispatcher.resume(first.runId, "again")).toThrow("사용자 응답");
  });

  it("rejects unsupported resumes and unknown modes without creating a run", async () => {
    const canvas = workflow("doc", "canvas");
    delete canvas.resume;
    const dispatcher = new WorkflowDispatcher(db, [canvas], async () => "doc");
    const request = input("draft", "unknown");
    await expect(dispatcher.start(request)).rejects.toThrow("unknown workflow");
    const result = await dispatcher.start({ ...request, mode: "doc" });
    setRunStatus(db, result.runId, "waiting_user");
    expect(() => dispatcher.resume(result.runId, "edit")).toThrow("전용 화면");
    expect(getRun(db, result.runId).status).toBe("waiting_user");
  });

  it("rejects duplicate registrations and invalid input before routing", async () => {
    const flow = workflow("chat", "agent");
    expect(() => new WorkflowDispatcher(db, [flow, workflow("chat")], async () => "chat")).toThrow("duplicate");
    expect(() => new WorkflowDispatcher(db, [flow, workflow("doc", "agent")], async () => "chat")).toThrow("duplicate");
    expect(() => new WorkflowDispatcher(db, [], async () => "chat")).toThrow("required");
    const route = vi.fn(async () => "chat");
    const dispatcher = new WorkflowDispatcher(db, [flow], route);
    await expect(dispatcher.start(input("  "))).rejects.toThrow("요청 내용");
    await expect(dispatcher.start({ ...input(), workspaceId: "other" })).rejects.toThrow("작업 공간");
    expect(route).not.toHaveBeenCalled();
  });

  it("serializes starts per thread while allowing separate threads to route", async () => {
    let finish!: (id: string) => void;
    const route = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    const dispatcher = new WorkflowDispatcher(db, [workflow("chat", "agent")], route);
    const request = input();
    const first = dispatcher.start(request);
    await expect(dispatcher.start(request)).rejects.toThrow("진행 중");
    finish("chat");
    await first;
    await expect(dispatcher.start(request)).rejects.toThrow("사용자 응답");
    const other = dispatcher.start(input());
    finish("chat");
    await expect(other).resolves.toMatchObject({ kind: "agent" });
  });

  it("rechecks open runs after routing and releases the lock on failure", async () => {
    const request = input();
    const flow = workflow("chat", "agent");
    const route = vi.fn(async () => {
      flow.start(request);
      return "chat";
    });
    const dispatcher = new WorkflowDispatcher(db, [flow], route);
    await expect(dispatcher.start(request)).rejects.toThrow("진행 중");
    expect(flow.start).toHaveBeenCalledTimes(1);
    const retry = input();
    route.mockRejectedValueOnce(new Error("offline"));
    await expect(dispatcher.start(retry)).rejects.toThrow("offline");
    await expect(dispatcher.start({ ...retry, mode: "chat" })).resolves.toMatchObject({ kind: "agent" });
  });

  it("cancels persisted waiting runs once, preserving their trace", () => {
    const flow = workflow("chat", "agent");
    const handle = flow.start(input());
    setRunStatus(db, handle.runId, "waiting_user");
    expect(cancelWaitingRun(db, handle.runId, "canvas")).toBe(false);
    expect(cancelWaitingRun(db, handle.runId, "agent")).toBe(true);
    expect(cancelWaitingRun(db, handle.runId, "agent")).toBe(false);
    expect(getRun(db, handle.runId)).toMatchObject({ status: "cancelled", errorCode: "CANCELLED" });
    expect(readTrace(db, handle.runId).at(-1)).toMatchObject({ type: "run.failed", payload: { code: "CANCELLED" } });
  });
});
