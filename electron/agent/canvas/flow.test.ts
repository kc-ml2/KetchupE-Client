// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentStreamEvent } from "../../../src/app-types/Agent.types.ts";
import type { CanvasInterrupt } from "../../../src/app-types/CanvasEdit.types.ts";
import { openAgentDb } from "../../db/openAgentDb.ts";
import { Tomato } from "../../tomato/tomato.ts";
import { createFixtureClient } from "../modelClient.ts";
import { DEFAULT_POLICY_PROFILE } from "../policy.ts";
import { createThread, ensureWorkspace, getRun, loadThread } from "../store.ts";
import { readTrace } from "../trace.ts";
import { CanvasFlow, anchorRelevance } from "./flow.ts";
import { findCanvasByRun, headVersion } from "./store.ts";

const draftJson = (title: string) => JSON.stringify({
  metadata: { title, parties: [{ label: "갑", name: "A사" }] },
  sections: [
    { section_type: "preamble", title: "전문", blocks: [{ text: "갑 A사와 을 {{을 회사명}}은 다음과 같이 계약한다.", source_refs: [] }] },
    { section_type: "article", title: "제1조 (대금)", blocks: [{ text: "대금은 {{계약 금액}}으로 한다.", source_refs: [] }] },
  ],
  missing_terms: [{ label: "계약 금액", description: "총액" }],
});

let temporary: string;
let tomato: Tomato;
const db = openAgentDb(":memory:");
const workspace = ensureWorkspace(db);
const events: AgentStreamEvent[] = [];

function flow(completions: string[]) {
  return new CanvasFlow({
    db,
    model: createFixtureClient({ decide: [], complete: completions }),
    retrieval: {
      search: (query, collections, limit) => tomato.search(query, { collections, mode: "keyword", limit }),
      getChunks: (ids) => tomato.getChunks(ids),
      listSources: (collections) => tomato.listSources(collections),
      getSourceChunks: (sourceId) => tomato.getSourceChunks(sourceId),
    },
    profile: DEFAULT_POLICY_PROFILE,
    activeCollections: () => ["work"],
    emit: (event) => events.push(event),
  });
}

const lastInterrupt = () => (events.filter((event) => event.type === "ask_user").at(-1)?.payload as { interrupt: CanvasInterrupt }).interrupt;

beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), "canvas-flow-"));
  const docs = join(temporary, "docs");
  await mkdir(docs);
  await writeFile(join(docs, "표준 용역계약서.md"), "# 표준 용역계약서\n\n## 제1조 목적\n\n본 계약은 용역의 범위를 정한다.\n");
  await writeFile(join(docs, "표준 위탁계약서.md"), "# 표준 위탁계약서\n\n## 제1조 목적\n\n본 계약은 위탁 업무를 정한다.\n");
  await writeFile(join(docs, "회의록.md"), "# 회의록\n\n계약 금액은 천만원으로 논의했다.\n");
  tomato = new Tomato(join(temporary, "home"));
  await tomato.registerCollection(docs, "work");
});

afterAll(async () => {
  await rm(temporary, { recursive: true, force: true });
});

describe("canvas flow", () => {
  it("cancels a waiting canvas, preserving its draft and rejecting later edits", async () => {
    const thread = createThread(db, workspace.id);
    const instance = flow([draftJson("초안")]);
    const handle = instance.start({ workspaceId: workspace.id, threadId: thread.id, instruction: "초안 작성", canvasType: "generic" });
    await handle.done;
    expect(getRun(db, handle.runId).status).toBe("waiting_user");
    const lastSeq = events.filter((event) => event.runId === handle.runId).at(-1)!.seq;
    instance.cancel(handle.runId);
    expect(getRun(db, handle.runId).status).toBe("cancelled");
    expect(findCanvasByRun(db, handle.runId)).toBeDefined();
    expect(events.at(-1)).toMatchObject({ runId: handle.runId, type: "failed", payload: { code: "CANCELLED" } });
    expect(events.at(-1)!.seq).toBeGreaterThan(lastSeq);
    expect(() => instance.applyEdit(handle.runId, { op: "finalize" })).toThrow("편집을 기다리는");
  });

  it("ranks template candidates by bigram relevance", () => {
    expect(anchorRelevance("A사와 용역 계약서 작성", "표준 용역계약서.md")).toBeGreaterThan(anchorRelevance("A사와 용역 계약서 작성", "표준 위탁계약서.md"));
  });

  it("asks which standard to use when ambiguous, drafts, edits with versions, undo, and finalizes", async () => {
    const thread = createThread(db, workspace.id);
    const instance = flow(["contract", draftJson("용역 계약서"), "대금은 이천만원으로 한다.", draftJson("용역 계약서 v2")]);
    const started = instance.start({ workspaceId: workspace.id, threadId: thread.id, instruction: "A사와 계약서 작성해줘" });
    await started.done;
    expect(getRun(db, started.runId)).toMatchObject({ status: "waiting_user", kind: "canvas" });
    const choice = lastInterrupt();
    expect(choice.type).toBe("awaiting_anchor_choice");
    if (choice.type !== "awaiting_anchor_choice") throw new Error("unexpected");
    expect(choice.candidates.map((candidate) => candidate.name).sort()).toEqual(["표준 용역계약서.md", "표준 위탁계약서.md"]);

    await instance.resumeAnchorChoice(started.runId, { document_ids: [choice.candidates[0].document_id], skip: false, anchor_only: false }).done;
    const edit = lastInterrupt();
    expect(edit.type).toBe("awaiting_edit");
    if (edit.type !== "awaiting_edit") throw new Error("unexpected");
    expect(edit.can_undo).toBe(false);
    expect(edit.missing_parties?.map((party) => party.label)).toEqual(["을"]);
    const canvas = findCanvasByRun(db, started.runId)!;
    expect(canvas.references.some((ref) => ref.kind === "anchor")).toBe(true);
    const v1 = headVersion(db, canvas)!;
    expect(v1.payload.missing_terms.map((term) => term.label)).toEqual(["을 회사명", "계약 금액"]);
    expect(v1.payload.metadata.parties).toEqual([{ label: "갑", role: "client", name: "A사", address: "", representative: "" }, { label: "을", role: "vendor", name: "", address: "", representative: "" }]);
    expect(loadThread(db, thread.id).messages.map((message) => message.role)).toEqual(["user", "user", "assistant"]);

    // set_terms: no LLM
    await instance.applyEdit(started.runId, { op: "set_terms", terms: [{ label: "계약 금액", value: "천만원" }] }, "미정 항목 입력").done;
    const v2 = headVersion(db, findCanvasByRun(db, started.runId)!)!;
    expect(v2.payload.sections[1].blocks[0].text).toBe("대금은 천만원으로 한다.");
    expect(v2.payload.missing_terms.map((term) => term.label)).toEqual(["을 회사명"]);
    expect(lastInterrupt()).toMatchObject({ type: "awaiting_edit", can_undo: true, can_redo: false });

    // feedback edit: LLM rewrite of one block
    await instance.applyEdit(started.runId, { op: "edit", block_id: "blk_002_001", feedback: "이천만원으로" }).done;
    const v3 = headVersion(db, findCanvasByRun(db, started.runId)!)!;
    expect(v3.payload.sections[1].blocks[0].text).toBe("대금은 이천만원으로 한다.");

    // undo moves the head pointer, redo comes back
    await instance.applyEdit(started.runId, { op: "undo" }).done;
    expect(findCanvasByRun(db, started.runId)!.headVersionId).toBe(v2.id);
    expect(lastInterrupt()).toMatchObject({ type: "awaiting_edit", can_undo: true, can_redo: true });
    await instance.applyEdit(started.runId, { op: "redo" }).done;
    expect(findCanvasByRun(db, started.runId)!.headVersionId).toBe(v3.id);

    // malformed op → error surfaced, no new version
    await instance.applyEdit(started.runId, { op: "delete", block_id: "nope" }).done;
    expect(lastInterrupt()).toMatchObject({ type: "awaiting_edit", error: "블록을 찾을 수 없습니다: nope" });
    expect(findCanvasByRun(db, started.runId)!.headVersionId).toBe(v3.id);

    // regenerate keeps filled parties
    await instance.applyEdit(started.runId, { op: "regenerate", feedback: "더 간결하게" }).done;
    const v4 = headVersion(db, findCanvasByRun(db, started.runId)!)!;
    expect(String(v4.payload.metadata.title)).toBe("용역 계약서 v2");

    await instance.applyEdit(started.runId, { op: "finalize" }, "문서 확정").done;
    expect(getRun(db, started.runId).status).toBe("completed");
    expect(findCanvasByRun(db, started.runId)!.status).toBe("finalized");
    expect(loadThread(db, thread.id).messages.at(-1)?.content).toContain("확정");
    expect(readTrace(db, started.runId).filter((event) => event.type === "canvas.updated").length).toBeGreaterThanOrEqual(5);
    expect(events.some((event) => event.type === "canvas")).toBe(true);
  });

  it("auto-binds a lone template and restores the view after a pause", async () => {
    const thread = createThread(db, workspace.id);
    const instance = flow(["proposal", draftJson("워크숍 기안")]);
    await writeFile(join(temporary, "docs", "기안서 양식.md"), "# 기안서 양식\n\n## 제목\n\n기안 제목을 적는다.\n\n## 본문\n\n배경과 내용, 기대효과를 적는다.\n");
    await tomato.sync("work");
    const started = instance.start({ workspaceId: workspace.id, threadId: thread.id, instruction: "워크숍 기안서 써줘" });
    await started.done;
    const view = instance.view(started.runId);
    expect(view.interrupt?.type).toBe("awaiting_edit");
    expect(view.canvas?.canvas_type).toBe("proposal");
    expect(findCanvasByRun(db, started.runId)!.references.filter((ref) => ref.kind === "anchor").length).toBeGreaterThan(0);
    const source = findCanvasByRun(db, started.runId)!.references[0];
    expect(instance.sourcePath(view.canvas!.canvas_id, source.document_id)).toBe(source.path);
  });

  it("keeps the run editable when a regenerate fails", async () => {
    const thread = createThread(db, workspace.id);
    const instance = flow(["generic", draftJson("메모"), "죄송합니다, JSON이 아닙니다"]);
    const started = instance.start({ workspaceId: workspace.id, threadId: thread.id, instruction: "아무 문서" });
    await started.done;
    const before = findCanvasByRun(db, started.runId)!.headVersionId;
    await instance.applyEdit(started.runId, { op: "regenerate", feedback: "더 길게" }).done;
    expect(getRun(db, started.runId).status).toBe("waiting_user");
    expect(findCanvasByRun(db, started.runId)!.headVersionId).toBe(before);
    expect(lastInterrupt()).toMatchObject({ type: "awaiting_edit" });
    expect((lastInterrupt() as { error?: string }).error).toContain("재작성 실패");
    // still editable afterwards
    await instance.applyEdit(started.runId, { op: "set_terms", terms: [{ label: "계약 금액", value: "1원" }] }).done;
    expect(findCanvasByRun(db, started.runId)!.headVersionId).not.toBe(before);
  });

  it("fails cleanly when the model returns no JSON tree", async () => {
    const thread = createThread(db, workspace.id);
    const instance = flow(["generic", "죄송합니다"]);
    const started = instance.start({ workspaceId: workspace.id, threadId: thread.id, instruction: "아무 문서" });
    await started.done;
    expect(getRun(db, started.runId)).toMatchObject({ status: "failed", errorCode: "MODEL_PROTOCOL" });
  });
});
