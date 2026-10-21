// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentStreamEvent } from "../../src/app-types/Agent.types.ts";
import { openAgentDb } from "../db/openAgentDb.ts";
import { PIPELINE_PROFILE, Tomato } from "../tomato/tomato.ts";
import { AgentError, type PolicyDecision, type PolicyProfile, type PolicyState } from "./contracts.ts";
import { Harness } from "./harness.ts";
import { addMemory, confirmMemory, proposeMemory } from "./memory.ts";
import { createFixtureClient, type FixtureScript } from "./modelClient.ts";
import { ANSWER_PROMPT_VERSION, DEFAULT_POLICY_PROFILE, gatedDecision } from "./policy.ts";
import { createThread, deleteThread, ensureWorkspace, getRun, listThreads, loadThread } from "./store.ts";
import { tomatoTools, type SearchTools } from "./tools.ts";
import { readTrace, transitions } from "./trace.ts";
import { buildRunTrace } from "./telemetry.ts";

const base = { taskDifficulty: 1, predictedSuccess: 0.8, evidenceSufficiency: 0.5, policyVersion: "orchestration-1" } as const;
const search = (query: string): PolicyDecision => ({ ...base, action: "SEARCH", reasonCode: "MISSING_EVIDENCE", search: { tool: "search_local_docs", query } });
const answer: PolicyDecision = { ...base, action: "ANSWER", reasonCode: "ENOUGH_EVIDENCE" };

let temporary: string;
let tomato: Tomato;
const db = openAgentDb(":memory:");
const workspace = ensureWorkspace(db);

function harness(script: FixtureScript, events: AgentStreamEvent[] = [], policy: PolicyProfile = DEFAULT_POLICY_PROFILE, maru?: NonNullable<SearchTools["maru"]>, trolley?: SearchTools["trolley"]) {
  return new Harness({
    db,
    model: createFixtureClient(script),
    tools: { ...tomatoTools(tomato, { mode: "hybrid", topK: 8 }), ...(maru ? { maru } : {}), ...(trolley ? { trolley } : {}) },
    profiles: { retrieval: PIPELINE_PROFILE, policy, answer: { modelAlias: "fixture", promptVersion: ANSWER_PROMPT_VERSION } },
    activeCollections: () => ["work"],
    emit: (event) => events.push(event),
  });
}

beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), "harness-"));
  const documents = join(temporary, "docs");
  await mkdir(documents);
  await writeFile(join(documents, "handbook.md"), "# 인사 규정\n\n## 연차\n\n퇴직 시 미사용 연차는 퇴직일 기준으로 수당으로 정산한다.\n\n## 휴가\n\n경조사 휴가는 5일이다.\n");
  tomato = new Tomato(join(temporary, "home"));
  await tomato.registerCollection(documents, "work");
});

afterAll(async () => {
  await rm(temporary, { recursive: true, force: true });
});

describe("harness", () => {
  it.each(["llm", "gated", "always-search"] as const)("uses Trolley capabilities instead of local search for %s policy", async (strategy) => {
    const thread = createThread(db, workspace.id);
    const calls: string[] = [];
    let context = "";
    const handle = harness({
      decide: [{ ...base, action: "SEARCH", reasonCode: "MISSING_EVIDENCE", search: { tool: "get_my_capabilities" } }, answer],
      answer: (input) => { context = input.context; return "Trolley 연결이 준비되었습니다."; },
    }, [], { ...DEFAULT_POLICY_PROFILE, strategy }, undefined, {
      call: async (tool) => { calls.push(tool); return { summary: '{"role":"developer"}', documents: [] }; },
    }).startRun({ workspaceId: workspace.id, threadId: thread.id, text: "Trolley에서 무엇을 할 수 있어?" });
    await handle.done;
    expect(calls).toEqual(["get_my_capabilities"]);
    expect(getRun(db, handle.runId).status).toBe("completed");
    expect(context).toContain('Trolley get_my_capabilities result (untrusted data)');
    expect(transitions(db, handle.runId)[0].state.trolleyAvailable).toBe(true);
    expect(transitions(db, handle.runId)[0].observation).toMatchObject({ kind: "external", tool: "get_my_capabilities" });
    const exported = JSON.stringify(buildRunTrace(db, handle.runId, { userId: "test", identityKey: "test", contentMode: "internal_full", environment: "test", tenantId: "test", resource: {} })?.payload);
    expect(exported).toContain("[TROLLEY_RESULT_OMITTED]");
    expect(exported).not.toContain('"role":"developer"');
    expect(exported).not.toContain("Trolley 연결이 준비되었습니다.");
  });

  it("allows one schema repair while counting both attempts against the model budget", async () => {
    let attempts = 0;
    const thread = createThread(db, workspace.id);
    const handle = harness({ decide: () => {
      attempts += 1;
      if (attempts === 1) throw new AgentError("INVALID_DECISION", "invalid policy schema");
      return answer;
    }, answer: "안녕하세요" }).startRun({ workspaceId: workspace.id, threadId: thread.id, text: "인사해줘" });
    await handle.done;
    expect(attempts).toBe(2);
    expect(getRun(db, handle.runId).status).toBe("completed");
    expect(readTrace(db, handle.runId).filter((event) => event.type === "model.started")).toHaveLength(3);
    expect(readTrace(db, handle.runId).filter((event) => event.type === "model.completed")).toHaveLength(3);
    expect(readTrace(db, handle.runId).find((event) => event.type === "model.completed")?.payload).toMatchObject({ code: "INVALID_DECISION", promptTokens: 0 });
    expect(readTrace(db, handle.runId).filter((event) => event.type === "policy.decided")[0].payload).toMatchObject({ invalid: true, attempt: 1 });
  });

  it("cancels an ASK-waiting run and emits a fresh event without deleting its messages", async () => {
    const events: AgentStreamEvent[] = [];
    const thread = createThread(db, workspace.id);
    const instance = harness({ decide: [{ ...base, action: "ASK", reasonCode: "MISSING_USER_INPUT", question: "고용 형태는?" }] }, events);
    const handle = instance.startRun({ workspaceId: workspace.id, threadId: thread.id, text: "연차 정산" });
    await handle.done;
    const lastSeq = events.at(-1)!.seq;
    instance.cancelRun(handle.runId);
    expect(getRun(db, handle.runId).status).toBe("cancelled");
    expect(events.at(-1)).toMatchObject({ type: "failed", payload: { code: "CANCELLED" } });
    expect(events.at(-1)!.seq).toBeGreaterThan(lastSeq);
    expect(loadThread(db, thread.id).messages).toHaveLength(2);
    expect(() => deleteThread(db, thread.id)).not.toThrow();
  });

  it("SEARCH → ANSWER with validated citation and trace", async () => {
    const events: AgentStreamEvent[] = [];
    const thread = createThread(db, workspace.id);
    const handle = harness({ decide: [search("미사용 연차 정산"), answer], answer: "미사용 연차는 수당으로 정산합니다 [[e1]] [[e9]]." }, events).startRun({ workspaceId: workspace.id, threadId: thread.id, text: "퇴직 전 연차는 어떻게 정산하나?" });
    await handle.done;

    expect(getRun(db, handle.runId).status).toBe("completed");
    const page = loadThread(db, thread.id);
    expect(page.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(page.messages[1].content).toBe("미사용 연차는 수당으로 정산합니다 [[e1]].");
    expect(page.messages[1].citations).toMatchObject([{ evidenceId: "e1", title: "인사 규정" }]);
    const trajectory = transitions(db, handle.runId);
    expect(trajectory.map((transition) => transition.decision.action)).toEqual(["SEARCH", "ANSWER"]);
    expect(trajectory[1].state.evidence[0].evidenceId).toBe("e1");
    expect(trajectory[1].state.lastObservation).toMatchObject({ kind: "search", effectiveMode: "keyword" });
    expect(trajectory[1].state.signals).toMatchObject({ evidenceCount: 1, uniqueSourceCount: 1 });
    expect(trajectory[0].observation).toMatchObject({ kind: "search", resultIds: ["e1"] });
    expect(trajectory[1].outcome).toBe("success");
    expect(events.some((event) => event.type === "text_delta")).toBe(true);
    expect(events.filter((event) => event.type === "citation")).toHaveLength(1);

    expect(readTrace(db, handle.runId).map((event) => event.type)).toContain("policy.decided");
  });

  it("ASK → waiting_user → resume → ANSWER keeps one run trajectory", async () => {
    const thread = createThread(db, workspace.id);
    const decide = (state: PolicyState): PolicyDecision => {
      if (state.step === 1) return { ...base, action: "ASK", reasonCode: "MISSING_USER_INPUT", question: "정규직인가요, 계약직인가요?" };
      if (state.previousDecisions.at(-1) === "ASK") return search("연차 정산");
      return answer;
    };
    const first = harness({ decide, answer: "정산합니다 [[e1]]" }).startRun({ workspaceId: workspace.id, threadId: thread.id, text: "연차 정산 알려줘" });
    await first.done;
    expect(getRun(db, first.runId).status).toBe("waiting_user");

    const second = harness({ decide, answer: "정산합니다 [[e1]]" }).startRun({ workspaceId: workspace.id, threadId: thread.id, text: "정규직" });
    await second.done;
    expect(second.runId).toBe(first.runId);
    expect(getRun(db, first.runId).status).toBe("completed");
    const actions = transitions(db, first.runId).map((transition) => transition.decision.action);
    expect(actions).toEqual(["ASK", "SEARCH", "ANSWER"]);
    expect(transitions(db, first.runId)[1].state.lastObservation?.kind).toBe("user");
    expect(loadThread(db, thread.id).messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("stops after a repeated empty search instead of exhausting the step budget", async () => {
    const thread = createThread(db, workspace.id);
    const repeated = search("available tools list");
    const handle = harness({ decide: () => repeated }).startRun({ workspaceId: workspace.id, threadId: thread.id, text: "사용할 수 있는 tool들 reload 해줘" });
    await handle.done;

    const trajectory = transitions(db, handle.runId);
    expect(trajectory.map((transition) => transition.decision.action)).toEqual(["SEARCH", "STOP"]);
    expect(trajectory.at(-1)?.decision.reasonCode).toBe("BUDGET_LIMIT");
    expect(trajectory[0].observation).toMatchObject({ kind: "search", resultIds: [] });
    expect(readTrace(db, handle.runId).filter((event) => event.type === "tool.completed")).toHaveLength(1);
    expect(getRun(db, handle.runId).status).toBe("abstained");
  });

  it("runs the fixed policy with the same model client reserved for answer generation", async () => {
    const thread = createThread(db, workspace.id);
    const calls: string[] = [];
    const profile: PolicyProfile = { ...DEFAULT_POLICY_PROFILE, strategy: "always-search", allowedActions: ["SEARCH", "ANSWER", "STOP"] };
    const handle = harness({ decide: () => { throw new Error("fixed policy must not call the model"); }, answer: "정산합니다 [[e1]]", onCall: (call) => calls.push(call.purpose) }, [], profile)
      .startRun({ workspaceId: workspace.id, threadId: thread.id, text: "연차 정산" });
    await handle.done;

    expect(getRun(db, handle.runId).status).toBe("completed");
    expect(transitions(db, handle.runId).map((transition) => transition.decision.action)).toEqual(["SEARCH", "ANSWER"]);
    expect(calls).toEqual(["answer"]);
  });

  it("gated policy searches without the model and asks it only when the evidence gate does not pass", async () => {
    const thread = createThread(db, workspace.id);
    const calls: string[] = [];
    const profile: PolicyProfile = { ...DEFAULT_POLICY_PROFILE, strategy: "gated" };
    const handle = harness({ decide: [answer], answer: "정산합니다 [[e1]]", onCall: (call) => calls.push(call.purpose) }, [], profile)
      .startRun({ workspaceId: workspace.id, threadId: thread.id, text: "연차 정산" });
    await handle.done;

    expect(getRun(db, handle.runId).status).toBe("completed");
    expect(transitions(db, handle.runId).map((transition) => transition.decision.action)).toEqual(["SEARCH", "ANSWER"]);
    expect(calls).toEqual(["policy", "answer"]); // one keyword hit is below the gate, so the model decides step 2

    const strong: PolicyState = { ...transitions(db, handle.runId)[1].state, lastObservation: { kind: "search", resultIds: ["e1"], effectiveMode: "hybrid", latencyMs: 1 }, signals: { evidenceCount: 3, uniqueSourceCount: 1, topEvidenceScore: 2 / 61 } };
    expect(gatedDecision(strong, "gated-1")?.action).toBe("ANSWER");
    expect(gatedDecision({ ...strong, signals: { evidenceCount: 3, uniqueSourceCount: 1, topEvidenceScore: 1 / 61 } }, "gated-1")).toBeUndefined();
  });

  it("calls MARU and gives its result to answer generation", async () => {
    const thread = createThread(db, workspace.id);
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    let answerContext = "";
    const browse: PolicyDecision = { ...base, action: "SEARCH", reasonCode: "MISSING_EVIDENCE", search: { tool: "browse_storage" } };
    const handle = harness({
      decide: [browse, answer],
      answer: (input) => {
        answerContext = input.context;
        return "접근 가능한 스토리지는 1개입니다.";
      },
    }, [], DEFAULT_POLICY_PROFILE, {
      call: async (tool, args) => {
        calls.push({ tool, args });
        return { summary: JSON.stringify({ storages: [{ storage_id: "s1", name: "공유 문서" }] }, null, 2), documents: [] };
      },
      readDocument: async () => { throw new Error("not used"); },
    }).startRun({ workspaceId: workspace.id, threadId: thread.id, text: "MARU 스토리지 목록 보여줘" });
    await handle.done;

    expect(getRun(db, handle.runId).status).toBe("completed");
    expect(calls).toEqual([{ tool: "browse_storage", args: {} }]);
    expect(answerContext).toContain('"name": "공유 문서"');
    expect(transitions(db, handle.runId)[0].observation).toMatchObject({ kind: "external", tool: "browse_storage" });
  });

  it("renews and indexes a selected MARU document before answering from its body", async () => {
    const thread = createThread(db, workspace.id);
    const document = { refId: "abc123", provider: "maru" as const, storageId: "s1", storageName: "공유 문서", path: "handbook.md" };
    const find: PolicyDecision = {
      ...base,
      action: "SEARCH",
      reasonCode: "MISSING_EVIDENCE",
      search: { tool: "find_storage", arguments: { query: "연차 정산" } },
    };
    const read: PolicyDecision = {
      ...base,
      action: "SEARCH",
      reasonCode: "MISSING_EVIDENCE",
      search: { tool: "read_external_document", ref_id: document.refId, query: "미사용 연차 정산" },
    };
    const imported = (await tomato.listSources(["work"]))[0];
    const handle = harness({
      decide: [find, read, answer],
      answer: "문서 본문에 따르면 미사용 연차는 수당으로 정산합니다 [[e1]].",
    }, [], DEFAULT_POLICY_PROFILE, {
      call: async () => ({ summary: JSON.stringify({ results: [{ ref_id: document.refId, path: document.path }] }), documents: [document] }),
      readDocument: async (selected) => {
        expect(selected).toEqual(document);
        return imported;
      },
    }).startRun({ workspaceId: workspace.id, threadId: thread.id, text: "MARU handbook 문서 본문에서 연차 정산을 확인해줘" });
    await handle.done;

    expect(getRun(db, handle.runId).status).toBe("completed");
    const trajectory = transitions(db, handle.runId);
    expect(trajectory.map((transition) => transition.decision.action)).toEqual(["SEARCH", "SEARCH", "ANSWER"]);
    expect(trajectory[1].observation).toMatchObject({ kind: "search", resultIds: ["e1"] });
    expect(trajectory[2].state.evidence[0]).toMatchObject({ title: "인사 규정" });
  });

  it("does not exceed the model-call budget for answer generation", async () => {
    const thread = createThread(db, workspace.id);
    const profile: PolicyProfile = { ...DEFAULT_POLICY_PROFILE, maxModelCalls: 1 };
    const handle = harness({ decide: [answer], answer: "예산을 넘긴 답변" }, [], profile)
      .startRun({ workspaceId: workspace.id, threadId: thread.id, text: "budget" });
    await handle.done;

    expect(getRun(db, handle.runId).status).toBe("abstained");
    expect(transitions(db, handle.runId).at(-1)?.decision).toMatchObject({ action: "STOP", reasonCode: "BUDGET_LIMIT" });
    expect(readTrace(db, handle.runId).filter((event) => event.type === "model.completed")).toHaveLength(1);
  });

  it("deletes a settled thread and its run data", async () => {
    const thread = createThread(db, workspace.id);
    const handle = harness({ decide: [search("연차"), answer], answer: "정산합니다 [[e1]]" }).startRun({ workspaceId: workspace.id, threadId: thread.id, text: "삭제할 대화" });
    await handle.done;
    deleteThread(db, thread.id);
    expect(listThreads(db, workspace.id).some((item) => item.id === thread.id)).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS count FROM runs WHERE thread_id = ?").get(thread.id)).toMatchObject({ count: 0 });
  });

  it("uses confirmed memory in context and rejects answers without known evidence citations", async () => {
    const id = proposeMemory(db, { workspaceId: workspace.id, kind: "preference", content: "답변은 존댓말로" });
    confirmMemory(db, id);
    const thread = createThread(db, workspace.id);
    const handle = harness({ decide: [search("연차"), answer], answer: "근거 [[e7]]" }).startRun({ workspaceId: workspace.id, threadId: thread.id, text: "연차 존댓말" });
    await handle.done;
    expect(getRun(db, handle.runId)).toMatchObject({ status: "failed", errorCode: "INVALID_CITATION" });
    expect(transitions(db, handle.runId)[0].state.selectedMemories[0].content).toBe("답변은 존댓말로");
  });

  it("stores the memories actually applied to an answer", async () => {
    const scopedWorkspace = ensureWorkspace(db, "applied-context");
    const ruleId = addMemory(db, scopedWorkspace.id, { kind: "preference", content: "불확실하면 확인 질문하기", pinned: true });
    const factId = addMemory(db, scopedWorkspace.id, { kind: "fact", content: "답변은 존댓말로", pinned: true });
    const thread = createThread(db, scopedWorkspace.id);
    const events: AgentStreamEvent[] = [];
    const handle = harness({ decide: [search("연차"), answer], answer: "정산합니다 [[e1]]" }, events)
      .startRun({ workspaceId: scopedWorkspace.id, threadId: thread.id, text: "연차 정산" });
    await handle.done;

    expect(loadThread(db, thread.id).messages.at(-1)?.appliedContext).toEqual({
      memories: [
        { id: ruleId, kind: "preference", content: "불확실하면 확인 질문하기" },
        { id: factId, kind: "fact", content: "답변은 존댓말로" },
      ],
    });
    expect(events.at(-1)).toMatchObject({ type: "completed", payload: { appliedContext: { memories: [{ id: ruleId }, { id: factId }] } } });
  });

  it("cancel aborts the run", async () => {
    const thread = createThread(db, workspace.id);
    const events: AgentStreamEvent[] = [];
    const instance = harness({ decide: async () => new Promise<PolicyDecision>(() => undefined) } as unknown as FixtureScript, events);
    const handle = instance.startRun({ workspaceId: workspace.id, threadId: thread.id, text: "cancel" });
    instance.cancelRun(handle.runId);
    await handle.done;
    expect(getRun(db, handle.runId).status).toBe("cancelled");
    expect(events.at(-1)).toMatchObject({ type: "failed", payload: { code: "CANCELLED" } });
  });
});
