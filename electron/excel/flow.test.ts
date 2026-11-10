// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { openAgentDb } from "../db/openAgentDb.ts";
import { createThread, ensureWorkspace, getRunAction, getRun } from "../agent/store.ts";
import { BusinessFlow } from "../business/flow.ts";
import { WorkSources } from "../work/sources.ts";
import { createExcelTool, type ExcelDependencies } from "./tool.ts";
import { comparisonFixture } from "./fixtures.ts";
import { profileWorkbook, readAnalysisInputs } from "./workbook.ts";
import { runAnalysis } from "./sandbox.ts";
import { renderHtml } from "./render.ts";
import type { BusinessAction } from "../../src/app-types/BusinessTool.types.ts";

it("resumes export after DB reopen, keeps originals, and only publishes validated artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "excel-flow-"));
  let db = openAgentDb(join(root, "test.sqlite"));
  const emit = vi.fn();
  const { files, plan } = await comparisonFixture();
  const complete = vi.fn().mockResolvedValueOnce(JSON.stringify({ kind: "ask", reason: "candidates", question: "어느 파일이 전주인가요?" })).mockResolvedValueOnce(JSON.stringify(plan)).mockResolvedValue(JSON.stringify({ kind: "finish", summary: "요약" }));
  const exporter = vi.fn().mockRejectedValueOnce(new Error("일시 실패")).mockImplementation(async (report) => Buffer.from(renderHtml(report)));
  const tool = createExcelTool({ complete, profile: (bytes, _signal, query, inspection) => profileWorkbook(bytes, query, inspection), analyze: async (files, plan) => { const { rows, ...metadata } = await readAnalysisInputs(files, plan); return { ...metadata, rowCount: rows.length, result: await runAnalysis(plan.code, rows) }; }, export: exporter, pdf: async () => Buffer.from("%PDF-1.7\n%%EOF") });
  const make = () => new BusinessFlow(db, [tool], join(root, "output"), emit, async () => { throw new Error("HTML must use its own validator"); });
  let flow = make();
  try {
    ensureWorkspace(db);
    const thread = createThread(db, "default");
    const paths = files.map(file => join(root, `${file.id}.xlsx`));
    for (let i = 0; i < files.length; i++) await writeFile(paths[i], files[i].bytes);
    const sources = new WorkSources(db);
    await sources.register(paths, "file");
    const selected = [];
    for (const path of paths) {
      const source = sources.list().find(source => source.name === basename(path))!;
      selected.push(...await sources.files(source.id));
    }
    const input = { values: { request: "HTML로 비교해줘", format: "html" }, files: { source: selected } };
    const { runId } = flow.workflows()[0].start({ threadId: thread.id, workspaceId: "default", text: "엑셀 작업하기" });
    const first = getRunAction(db, runId) as BusinessAction;
    await expect(flow.submit(runId, first.id, { ...input, values: { ...input.values, format: "exe" } })).rejects.toThrow("선택 값");
    await flow.submit(runId, first.id, input);
    expect((getRunAction(db, runId) as BusinessAction).fields.some(field => field.key === "answer1")).toBe(true);
    await flow.stop(); db.close();
    db = openAgentDb(join(root, "test.sqlite")); flow = make();
    const answered = { ...input, values: { ...input.values, answer1: "file1은 전주, file2는 금주" } };
    await flow.workflows()[0].resume!(runId, answered.values.answer1).done;
    expect(JSON.parse(complete.mock.calls[1][1]).clarifications).toEqual([{ key: "answer1", question: "어느 파일이 전주인가요?", answer: answered.values.answer1 }]);
    expect(getRun(db, runId).status).toBe("waiting_user");
    expect(flow.artifacts(thread.id)).toHaveLength(0);
    await flow.stop(); db.close();
    db = openAgentDb(join(root, "test.sqlite")); flow = make();
    const action = getRunAction(db, runId) as BusinessAction;
    expect(action.lockedKeys).not.toContain("source");
    expect(action.fields).toContainEqual(expect.objectContaining({ key: "exportFormat" }));
    await flow.submit(runId, action.id, { ...action.input, values: { ...action.input.values, exportFormat: "html" } });
    expect(getRun(db, runId).status).toBe("completed");
    expect(complete).toHaveBeenCalledTimes(3);
    const [artifact] = flow.artifacts(thread.id);
    expect(await readFile(await flow.artifactPath(artifact.id), "utf8")).toContain("<!doctype html>");
    for (let i = 0; i < paths.length; i++) expect(await readFile(paths[i])).toEqual(Buffer.from(files[i].bytes));
    expect(await readFile(await flow.artifactPath(artifact.id), "utf8")).toContain("[file2] file2.xlsx / 기준: 2행");
    expect(emit.mock.calls.some(([event]) => event.type === "status" && event.payload.phase.includes("분석 계획"))).toBe(true);
    complete.mockReset().mockResolvedValueOnce(JSON.stringify({ ...plan, title: "수정된 비교" })).mockResolvedValue('{"kind":"finish","summary":"수정했습니다."}');
    const revised = flow.workflows()[0].start({ threadId: thread.id, workspaceId: "default", text: "이 결과를 다시 비교하고 제목을 수정해줘" });
    await revised.done;
    expect(getRun(db, revised.runId).status).toBe("completed");
    expect(flow.artifacts(thread.id)).toHaveLength(2);
    expect(JSON.parse(complete.mock.calls[0][1]).revision).toContain("다시 비교");
    expect(JSON.parse(complete.mock.calls[0][1]).computed).not.toBeNull();
    const timings = db.prepare("SELECT payload, duration_ms FROM trace_events WHERE run_id=? AND type='model.completed'").all(revised.runId);
    expect(timings).toHaveLength(2);
    for (const row of timings) {
      expect(JSON.parse(String(row.payload))).toMatchObject({ phase: "model", localOnly: true, durationMs: expect.any(Number) });
      expect(row.duration_ms).toBeGreaterThanOrEqual(0);
      expect(String(row.payload)).not.toContain("다시 비교");
    }
    expect(await readFile(await flow.artifactPath(artifact.id), "utf8")).not.toContain("수정된 비교");
  } finally { await flow.stop(); db.close(); await rm(root, { recursive: true, force: true }); }
});

it("migrates duplicate legacy answers after restart and bounds the input card over many questions", async () => {
  const root = await mkdtemp(join(tmpdir(), "excel-answers-"));
  let db = openAgentDb(join(root, "test.sqlite"));
  const { files } = await comparisonFixture();
  let question = 4;
  const complete = vi.fn<ExcelDependencies["complete"]>(async () => JSON.stringify({ kind: "ask", reason: "criteria", question: `미확정 기준 ${question++}` }));
  const tool = createExcelTool({ complete, profile: (bytes, _signal, query) => profileWorkbook(bytes, query), analyze: vi.fn(), export: vi.fn(), pdf: vi.fn() });
  const make = () => new BusinessFlow(db, [tool], join(root, "output"), vi.fn(), vi.fn());
  let flow = make();
  try {
    ensureWorkspace(db);
    const thread = createThread(db, "default"), path = join(root, "source.xlsx");
    await writeFile(path, files[0].bytes);
    const sources = new WorkSources(db);
    await sources.register([path], "file");
    const selected = await sources.files(sources.list()[0].id);
    const { runId } = flow.workflows()[0].start({ threadId: thread.id, workspaceId: "default", text: "그래프" });
    const old = JSON.parse(String(db.prepare("SELECT payload FROM business_jobs WHERE run_id=?").get(runId)!.payload));
    old.input = { values: { request: "그래프", answer3: "옛 답변" }, files: { source: selected } };
    old.fields.push({ key: "answer3", type: "text", label: "확인", required: true });
    old.pendingKeys = ["answer3"];
    old.checkpoint = { clarifications: [{ key: "answer3", question: "이전 범위", answer: "10000행" }, { key: "answer3", question: "현재 범위", answer: "옛 답변" }] };
    db.prepare("UPDATE business_jobs SET payload=? WHERE run_id=?").run(JSON.stringify(old), runId);
    await flow.stop(); db.close();
    db = openAgentDb(join(root, "test.sqlite")); flow = make();
    await flow.workflows()[0].resume!(runId, "전체 행으로 변경").done;
    const prompt = JSON.parse(complete.mock.calls[0][1]);
    expect(prompt.clarifications.map((item: { answer: string }) => item.answer)).toEqual(["10000행", "전체 행으로 변경"]);
    expect(prompt.latestInstruction).toEqual({ answer3: "전체 행으로 변경" });
    for (let i = 0; i < 32; i++) {
      const action = getRunAction(db, runId) as BusinessAction;
      expect(action.fields).toHaveLength(tool.fields.length + 1);
      expect(action.fields.at(-1)?.key).toBe(`answer${i + 4}`);
      await flow.workflows()[0].resume!(runId, `답변 ${i}`).done;
    }
    expect(complete).toHaveBeenCalledTimes(33);
    const saved = JSON.parse(String(db.prepare("SELECT payload FROM business_jobs WHERE run_id=?").get(runId)!.payload));
    expect(saved.checkpoint.clarifications).toHaveLength(12);
    expect(Object.keys(saved.input.values)).toEqual(["request"]);
  } finally { await flow.stop(); db.close(); await rm(root, { recursive: true, force: true }); }
}, 30000);
