// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ExcelJS from "exceljs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openAgentDb } from "../db/openAgentDb.ts";
import { createThread, ensureWorkspace, getRun, getRunAction, loadThread } from "../agent/store.ts";
import { WorkSources } from "../work/sources.ts";
import { SelectiveWorkbook } from "../work/selectiveWorkbook.ts";
import { loadWorkbook } from "../work/mapping.ts";
import { BusinessFlow } from "./flow.ts";
import { dailyCashTool } from "./dailyCash.ts";
import { annualReportFixture, fixtureBooks } from "./dailyCash/fixtures.ts";
import type { BusinessTool, ToolResult } from "./contracts.ts";
import type { BusinessAction, BusinessInput } from "../../src/app-types/BusinessTool.types.ts";

vi.mock("./dailyCash/hana.ts", async (original) => ({ ...await original<typeof import("./dailyCash/hana.ts")>(), fetchHana: vi.fn(async (day: string) => ({ date: day, requestedDate: day, round: "10", publishedAt: "테스트 고시", source: "fixture-only", fetchedAt: "2026-10-14T00:00:00Z", responseHash: "fixture", perUnit: { USD: "1400", JPY: "9.5", CNY: "200" } })) }));

let folder: string;
let db: ReturnType<typeof openAgentDb>;
let output: Buffer;
let input: BusinessInput;
let tool: BusinessTool;
let threadId: string;
let flow: BusinessFlow;
const emit = vi.fn();
const success = (): ToolResult => ({ status: "completed", summary: "테스트 업무 완료", file: { name: "테스트결과.xlsx", bytes: output }, checks: [{ name: "정답 비교", passed: true }], externalData: { rate: "fixture-only" } });
const makeFlow = (tools = [tool], timeout = 1000) => new BusinessFlow(db, tools, join(folder, "output"), emit, async (bytes, sheet) => { if (sheet) { const book = await (await SelectiveWorkbook.open(bytes)).loadSheet(sheet); expect(book.worksheets).toHaveLength(1); } else await loadWorkbook(bytes); }, timeout);
const start = () => flow.workflows()[0].start({ threadId, workspaceId: "default", text: "테스트 엑셀 만들어줘" }).runId;
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "business-tool-")); db = openAgentDb(join(folder, "agent.sqlite"));
  ensureWorkspace(db); threadId = createThread(db, "default").id; emit.mockReset();
  const book = new ExcelJS.Workbook(); book.addWorksheet("자료").addRows([["금액"], [100]]); output = Buffer.from(await book.xlsx.writeBuffer());
  const path = join(folder, "source.xlsx"); await writeFile(path, output);
  const sources = new WorkSources(db); const [source] = await sources.register([path], "file"); const [file] = await sources.files(source.id);
  input = { values: { businessDate: "2026-10-15" }, files: { source: [file] } };
  tool = { id: "fixture", title: "테스트 업무", version: "1.0", description: "테스트 전용", fields: [{ key: "businessDate", type: "date", label: "기준일", required: true }, { key: "source", type: "file", label: "원천", required: true }], execute: vi.fn(async () => success()) };
  flow = makeFlow();
});
afterEach(async () => { await flow.stop(); db.close(); await rm(folder, { recursive: true, force: true }); });

it("executes a registered tool using selected bytes and delivers only verified artifacts", async () => {
  const runId = start(); const action = getRunAction(db, runId)!;
  await flow.submit(runId, action.id, input);
  expect(getRun(db, runId).status).toBe("completed");
  expect(loadThread(db, threadId).messages.map((message) => [message.role, message.content])).toEqual([
    ["user", "테스트 엑셀 만들어줘"], ["assistant", "기준 정보와 원천 파일을 지정해 주세요."], ["user", "기준일: 2026-10-15\n원천: source.xlsx"], ["assistant", expect.stringContaining("테스트 업무 완료")],
  ]);
  expect(tool.execute).toHaveBeenCalledWith(expect.objectContaining({ values: input.values, files: { source: [{ bytes: output, fingerprint: expect.any(String), name: "source.xlsx" }] } }));
  const [artifact] = flow.artifacts(threadId); expect(artifact).toMatchObject({ runId, version: "1.0", name: "테스트결과.xlsx" });
  const path = await flow.artifactPath(artifact.id); expect(path).toContain(folder);
  await writeFile(path, "modified"); await expect(flow.artifactPath(artifact.id)).rejects.toThrow("변경");
  await expect(flow.submit(runId, action.id, input)).rejects.toThrow("이미 처리");
  expect(JSON.parse(String(db.prepare("SELECT audit FROM business_artifacts").get()!.audit)).externalData).toEqual({ rate: "fixture-only" });
});

it("allows opted-in request/file revisions but rejects changed bytes at a retained source path", async () => {
  tool.editable = true;
  tool.fields.push({ key: "request", type: "text", label: "요청", required: true }, { key: "revision", type: "text", label: "수정", required: false });
  tool.fields.find(field => field.key === "source")!.multiple = true;
  input.values.request = "합계";
  vi.mocked(tool.execute).mockResolvedValue({ status: "needs_input", question: "어떤 기준인가요?", fields: [{ key: "answer1", type: "text", label: "답변", required: true }], checkpoint: { report: { obsolete: true } } });
  const runId = start();
  await flow.submit(runId, getRunAction(db, runId)!.id, input);
  expect((getRunAction(db, runId) as BusinessAction).lockedKeys).toEqual([]);
  const nextBook = new ExcelJS.Workbook(); nextBook.addWorksheet("자료").addRows([["금액"], [200]]);
  const secondPath = join(folder, "second.xlsx"); await writeFile(secondPath, Buffer.from(await nextBook.xlsx.writeBuffer()));
  const sources = new WorkSources(db); await sources.register([secondPath], "file");
  const second = sources.list().find(source => source.name === "second.xlsx")!;
  const revised = { values: { ...input.values, request: "평균" }, files: { source: [...input.files.source, ...(await sources.files(second.id))] } };
  await flow.submit(runId, getRunAction(db, runId)!.id, revised);
  expect(vi.mocked(tool.execute).mock.calls[1][0].checkpoint).toEqual({});
  expect(vi.mocked(tool.execute).mock.calls[1][0].files.source).toHaveLength(2);
  await writeFile(join(folder, "source.xlsx"), "changed");
  await flow.workflows()[0].resume!(runId, "모든 값 기준으로").done;
  expect(tool.execute).toHaveBeenCalledTimes(2);
  expect((getRunAction(db, runId) as BusinessAction).question).toContain("원천 파일 내용이 변경");
});

it("validates every output before publishing any of a multi-file result", async () => {
  const good = success();
  if (good.status !== "completed") throw new Error("not completed");
  vi.mocked(tool.execute).mockResolvedValue({ ...good, additionalFiles: [{ name: "invalid.xlsx", bytes: Buffer.from("bad") }] });
  const runId = start();
  await flow.submit(runId, getRunAction(db, runId)!.id, input);
  expect(flow.artifacts(threadId)).toHaveLength(0);
  vi.mocked(tool.execute).mockResolvedValue({ ...good, additionalFiles: [{ name: "second.xlsx", bytes: output }] });
  await flow.submit(runId, getRunAction(db, runId)!.id, input);
  expect(flow.artifacts(threadId).map(item => item.name)).toEqual(["테스트결과.xlsx", "second.xlsx"]);
});

it("updates the selected original workbook after validating the generated workbook", async () => {
  const sourcePath = join(folder, "source.xlsx");
  const generated = new ExcelJS.Workbook(); generated.addWorksheet("결과").getCell("A1").value = "updated"; output = Buffer.from(await generated.xlsx.writeBuffer());
  tool.updateSource = "source";
  const runId = start(); const action = getRunAction(db, runId)!;
  await flow.submit(runId, action.id, input);
  const updated = new ExcelJS.Workbook(); await updated.xlsx.load(await readFile(sourcePath) as unknown as ExcelJS.Buffer);
  expect(updated.getWorksheet("결과")?.getCell("A1").value).toBe("updated");
  expect(getRun(db, runId).status).toBe("completed");
});

it("preserves newly added work-date plans through a balance correction and renewed final review", async () => {
  const books = fixtureBooks(); const status = books.status.worksheets[0];
  status.getCell("O2").value = 108000; status.getCell("O4").value = 108000;
  const sources = new WorkSources(db);
  const chosen: BusinessInput = { values: { workDate: "2026-10-14" }, files: {} };
  for (const [key, book, name] of [["previousReport", books.report, "report.xlsx"], ["weeklyPlans", books.weekly, "weekly.xlsx"], ["cashStatus", books.status, "261013_KC.xlsx"]] as const) {
    const path = join(folder, name); await writeFile(path, key === "previousReport" ? await annualReportFixture() : Buffer.from(await book.xlsx.writeBuffer()));
    const source = (await sources.register([path], "file")).find((item) => item.name === name)!;
    chosen.files[key] = await sources.files(source.id);
  }
  flow = makeFlow([dailyCashTool], 30000);
  const { runId, done } = flow.workflows()[0].start({ threadId, workspaceId: "default", text: "일일자금일보 작성" }); await done;
  const action = () => getRunAction(db, runId) as BusinessAction;
  await flow.submit(runId, action().id, chosen);
  expect(action().fields.find((field) => field.key === "actualEdits")?.type).toBe("movements");
  chosen.values.actualEdits = '{"changes":[],"add":[]}';
  const addedPlans = [{ direction: "out", description: "당일 추가 지급", party: "추가 거래처", amount: "5000" }, { direction: "in", description: "당일 추가 입금", party: "입금 거래처", amount: "1000" }];
  chosen.values.planEdits = JSON.stringify({ changes: [], add: addedPlans });
  await flow.submit(runId, action().id, chosen);
  expect(action().question).toContain("장부와 실제 잔고 차이");
  expect(action().question).not.toContain("형식이 변경");
  expect(action().fields.find((field) => field.key === "actualEdits")?.type).toBe("movements");
  expect(action().fields.find((field) => field.key === "planEdits")?.type).toBe("movements");
  expect(action().input.values.planEdits).toBe(chosen.values.planEdits);
  expect(action().lockedKeys).not.toContain("actualEdits");
  chosen.values.cashChanges = '{"140013557434:KRW":{"incoming":"10000","outgoing":"2000"}}';
  chosen.values.actualEdits = '{"changes":[{"index":2,"amount":"2000"}],"add":[]}';
  await flow.submit(runId, action().id, chosen);
  expect(action().question).toContain("최종 확인");
  chosen.values.review = action().fields.find((field) => field.key === "review")!.confirm!;
  const firstReview = chosen.values.review;
  addedPlans[0].amount = "6000";
  chosen.values.planEdits = JSON.stringify({ changes: [], add: addedPlans });
  await flow.submit(runId, action().id, chosen);
  expect(action().question).toContain("최종 확인");
  expect(action().input.values.planEdits).toBe(chosen.values.planEdits);
  chosen.values.review = action().fields.find((field) => field.key === "review")!.confirm!;
  expect(chosen.values.review).not.toBe(firstReview);
  await flow.submit(runId, action().id, chosen);
  expect(getRun(db, runId).status, action()?.question).toBe("completed");
  expect(flow.artifacts(threadId)).toHaveLength(2);
  const updated = await loadWorkbook(await readFile(join(folder, "report.xlsx")));
  expect(updated.worksheets).toHaveLength(367);
  expect(updated.getWorksheet("250101")!.getCell("H10").value).toBe(100000);
  expect(updated.getWorksheet("261013")!.getCell("H10").result).toBe(108000);
  const report = updated.getWorksheet("261013")!;
  expect(report.getCell("H237").result).toBe(101000);
  expect(report.getCell("F131").value).toContain("당일 추가 입금");
  expect(report.getCell("H131").value).toBe(1000);
  expect(report.getCell("F158").value).toContain("당일 추가 지급");
  expect(report.getCell("H158").value).toBe(6000);
}, 30000);

it("persists additional structured input across DB reopen and pins the tool version", async () => {
  vi.mocked(tool.execute).mockResolvedValueOnce({ status: "needs_input", question: "어떤 계좌인가요?", checkpoint: { fx: { value: "1300.00", date: "2026-10-15", source: "fixture" } }, fields: [{ key: "account", type: "text", label: "계좌", required: true }] });
  const runId = start(); const first = getRunAction(db, runId)!;
  await flow.submit(runId, first.id, input);
  expect(getRun(db, runId).status).toBe("waiting_user");
  await flow.stop(); db.close(); db = openAgentDb(join(folder, "agent.sqlite")); flow = makeFlow();
  const next = getRunAction(db, runId)!;
  expect(next).toMatchObject({ type: "business_tool", input, question: "어떤 계좌인가요?" });
  await expect(flow.submit(runId, first.id, input)).rejects.toThrow("변경된 입력");
  await expect(flow.submit(runId, next.id, input)).rejects.toThrow("계좌");
  await expect(flow.submit(runId, next.id, { ...input, values: { ...input.values, businessDate: "2026-10-16", account: "001" } })).rejects.toThrow("기준 정보");
  const updated = makeFlow([{ ...tool, version: "2.0" }]);
  await expect(updated.submit(runId, next.id, input)).rejects.toThrow("업무 버전");
  await flow.submit(runId, next.id, { ...input, values: { ...input.values, account: "001" } });
  expect(getRun(db, runId).status).toBe("completed");
  expect(tool.execute).toHaveBeenLastCalledWith(expect.objectContaining({ checkpoint: { fx: { value: "1300.00", date: "2026-10-15", source: "fixture" } } }));
});

it("does not reuse answers when the pinned source changed", async () => {
  vi.mocked(tool.execute).mockResolvedValueOnce({ status: "needs_input", question: "확인", fields: [{ key: "confirm", type: "text", label: "확인", required: true }] });
  const runId = start(); await flow.submit(runId, getRunAction(db, runId)!.id, input);
  await writeFile(join(folder, "source.xlsx"), "changed");
  await flow.submit(runId, getRunAction(db, runId)!.id, { ...input, values: { ...input.values, confirm: "yes" } });
  expect(getRun(db, runId).status).toBe("waiting_user"); expect(tool.execute).toHaveBeenCalledTimes(1); expect(flow.artifacts(threadId)).toEqual([]);
});

it("rejects missing, extra, invalid dates and unregistered file paths before calling the tool", async () => {
  const runId = start(); const actionId = getRunAction(db, runId)!.id;
  await expect(flow.submit(runId, actionId, { ...input, values: {} })).rejects.toThrow("기준일");
  await expect(flow.submit(runId, actionId, { ...input, values: { businessDate: "2026-02-30" } })).rejects.toThrow("기준일");
  await expect(flow.submit(runId, actionId, { ...input, values: { ...input.values, rogue: "x" } })).rejects.toThrow("등록되지 않은");
  await flow.submit(runId, actionId, { ...input, files: { source: [{ ...input.files.source[0], relativePath: "../outside.xlsx" }] } });
  expect(tool.execute).not.toHaveBeenCalled(); expect(getRun(db, runId).status).toBe("waiting_user");
});

it.each(["checks", "xlsx", "name", "throw"])("never publishes invalid output: %s", async (kind) => {
  vi.mocked(tool.execute).mockImplementation(async () => {
    if (kind === "throw") throw new Error("계산 실패");
    const result = success(); if (result.status !== "completed") throw new Error("fixture");
    if (kind === "checks") result.checks[0].passed = false;
    if (kind === "xlsx") result.file.bytes = Buffer.from("not excel");
    if (kind === "name") result.file.name = "../outside.xlsx";
    return result;
  });
  const runId = start(); await flow.submit(runId, getRunAction(db, runId)!.id, input);
  expect(getRun(db, runId).status).toBe("waiting_user"); expect(flow.artifacts(threadId)).toEqual([]);
});

it("does not let an existing XLSX tool publish other formats without an app validator", async () => {
  vi.mocked(tool.execute).mockResolvedValue({ status: "completed", summary: "test", file: { name: "report.html", bytes: Buffer.from("<!doctype html>") }, checks: [{ name: "shape", passed: true }] });
  const runId = start(); await flow.submit(runId, getRunAction(db, runId)!.id, input);
  expect(getRun(db, runId).status).toBe("waiting_user");
  expect(flow.artifacts(threadId)).toHaveLength(0);
});

it("ignores late completion after cancellation and prevents simultaneous submissions", async () => {
  let resolve!: (result: ToolResult) => void;
  let entered!: () => void; const started = new Promise<void>((done) => { entered = done; });
  vi.mocked(tool.execute).mockImplementation(() => { entered(); return new Promise((done) => { resolve = done; }); });
  const runId = start(); const actionId = getRunAction(db, runId)!.id;
  const pending = flow.submit(runId, actionId, input); await started;
  expect(getRun(db, runId).status).toBe("running");
  expect(loadThread(db, threadId).messages.at(-1)).toMatchObject({ role: "user", content: "기준일: 2026-10-15\n원천: source.xlsx" });
  expect(emit).toHaveBeenCalledWith(expect.objectContaining({ runId, type: "status", payload: expect.objectContaining({ messagesChanged: true }) }));
  await expect(flow.submit(runId, actionId, input)).rejects.toThrow("이미 처리");
  flow.cancel(runId); resolve(success()); await pending;
  expect(getRun(db, runId).status).toBe("cancelled"); expect(flow.artifacts(threadId)).toEqual([]);
});

it("rejects several files for a single-file field", async () => {
  const runId = start(); const [file] = input.files.source;
  await expect(flow.submit(runId, getRunAction(db, runId)!.id, { ...input, files: { source: [file, { ...file, name: "again.xlsx" }] } })).rejects.toThrow("하나만");
});

it("refuses the same file twice in a multi-file field before calling the tool", async () => {
  await flow.stop(); flow = makeFlow([{ ...tool, fields: tool.fields.map((field) => ({ ...field, multiple: field.type === "file" })) }]);
  const runId = start(); const [file] = input.files.source;
  await flow.submit(runId, getRunAction(db, runId)!.id, { ...input, files: { source: [file, file] } });
  expect(getRun(db, runId).status).toBe("waiting_user"); expect(tool.execute).not.toHaveBeenCalled();
});

it("times out a tool that never returns", async () => {
  vi.mocked(tool.execute).mockImplementation(() => new Promise(() => undefined)); flow = makeFlow([tool], 30);
  const runId = start(); await flow.submit(runId, getRunAction(db, runId)!.id, input);
  expect(getRun(db, runId).status).toBe("waiting_user"); expect(flow.artifacts(threadId)).toEqual([]);
});

it("starts daily cash by asking for the three real sources without producing an unverified report", async () => {
  flow = makeFlow([dailyCashTool]); const { runId, done } = flow.workflows()[0].start({ threadId, workspaceId: "default", text: "일일자금일보 작성해줘" }); await done;
  expect(getRun(db, runId).status).toBe("waiting_user"); expect(getRunAction(db, runId)).toMatchObject({ type: "business_tool" }); expect(flow.artifacts(threadId)).toEqual([]);
});

it("prefills Seoul's today as an editable date even without a connected folder, locking it only after the first run", async () => {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
  tool.suggest = (_files, day) => ({ values: { businessDate: day }, files: {} });
  const { runId, done } = flow.workflows()[0].start({ threadId, workspaceId: "default", text: "테스트" }); await done;
  expect(getRunAction(db, runId)).toMatchObject({ input: { values: { businessDate: today }, files: {} }, lockedKeys: [], question: "기준 정보와 원천 파일을 지정해 주세요." });
  vi.mocked(tool.execute).mockResolvedValueOnce({ status: "needs_input", question: "계좌?", fields: [{ key: "account", type: "text", label: "계좌", required: true }] });
  await flow.submit(runId, getRunAction(db, runId)!.id, { ...input, values: { businessDate: "2026-10-01" } });
  expect(tool.execute).toHaveBeenCalledWith(expect.objectContaining({ values: { businessDate: "2026-10-01" } }));
  expect(getRunAction(db, runId)).toMatchObject({ lockedKeys: expect.arrayContaining(["businessDate", "source"]) });
  await expect(flow.submit(runId, getRunAction(db, runId)!.id, { ...input, values: { businessDate: "2026-10-02", account: "a" } })).rejects.toThrow("변경할 수 없습니다");
});

it("allows correcting a supplemental answer when the tool asks for it again", async () => {
  const question: ToolResult = { status: "needs_input", question: "유효한 계좌를 입력하세요", fields: [{ key: "account", type: "text", label: "계좌", required: true }] };
  vi.mocked(tool.execute).mockResolvedValueOnce(question).mockResolvedValueOnce(question).mockResolvedValueOnce(success());
  const runId = start(); await flow.submit(runId, getRunAction(db, runId)!.id, input);
  await flow.submit(runId, getRunAction(db, runId)!.id, { ...input, values: { ...input.values, account: "wrong" } });
  expect(getRunAction(db, runId)).toMatchObject({ lockedKeys: expect.arrayContaining(["businessDate", "source"]) });
  await flow.submit(runId, getRunAction(db, runId)!.id, { ...input, values: { ...input.values, account: "correct" } });
  expect(getRun(db, runId).status).toBe("completed");
});
it("keeps the run and its answers after a tool error so a retry can finish it", async () => {
  vi.mocked(tool.execute).mockResolvedValueOnce({ status: "needs_input", question: "계좌?", fields: [{ key: "account", type: "text", label: "계좌", required: true }] })
    .mockRejectedValueOnce(new Error("일시 오류")).mockResolvedValueOnce(success());
  const runId = start(); await flow.submit(runId, getRunAction(db, runId)!.id, input);
  const answered = { ...input, values: { ...input.values, account: "001" } };
  await flow.submit(runId, getRunAction(db, runId)!.id, answered);
  const action = getRunAction(db, runId)!;
  expect(getRun(db, runId).status).toBe("waiting_user"); expect(action).toMatchObject({ type: "business_tool", question: expect.stringContaining("일시 오류"), input: answered, lockedKeys: expect.arrayContaining(["businessDate"]) });
  await flow.submit(runId, action.id, answered);
  expect(getRun(db, runId).status).toBe("completed"); expect(tool.execute).toHaveBeenCalledTimes(3);
});

it("does not publish when source access is revoked during execution", async () => {
  vi.mocked(tool.execute).mockImplementation(async () => { new WorkSources(db).remove(input.files.source[0].sourceId); return success(); });
  const runId = start(); await flow.submit(runId, getRunAction(db, runId)!.id, input);
  expect(getRun(db, runId).status).toBe("waiting_user"); expect(flow.artifacts(threadId)).toEqual([]);
});

it("persists workbook and PNG together and checks both fingerprints", async () => {
  const result = success(); if (result.status !== "completed") throw new Error("fixture");
  result.image = { name: "일보.png", bytes: await (await import("sharp")).default({ create: { width: 1, height: 1, channels: 4, background: "white" } }).png().toBuffer() };
  vi.mocked(tool.execute).mockResolvedValue(result);
  const runId = start(); await flow.submit(runId, getRunAction(db, runId)!.id, input);
  expect(getRun(db, runId).status).toBe("completed");
  expect(flow.artifacts(threadId).map((a) => a.name)).toEqual(["테스트결과.xlsx", "일보.png"]);
  for (const item of flow.artifacts(threadId)) expect(await flow.artifactPath(item.id)).toContain(item.name);
});
it.each(["../escape.png", "invalid.png"])("publishes neither artifact when an image is invalid: %s", async (name) => {
  const result = success(); if (result.status !== "completed") throw new Error("fixture"); result.image = { name, bytes: Buffer.from("not png") };
  vi.mocked(tool.execute).mockResolvedValue(result);
  const runId = start(); await flow.submit(runId, getRunAction(db, runId)!.id, input);
  expect(getRun(db, runId).status).toBe("waiting_user"); expect(flow.artifacts(threadId)).toEqual([]);
});

it("passes Korean file names to tools in composed (NFC) form even when the file system reports NFD", async () => {
  const nfd = "케찹이_데모.xlsx".normalize("NFD");
  // Different bytes from source.xlsx so registration does not resolve to the existing source.
  const book = new ExcelJS.Workbook(); book.addWorksheet("자료").addRows([["금액"], [200]]);
  const path = join(folder, nfd); await writeFile(path, Buffer.from(await book.xlsx.writeBuffer()));
  const sources = new WorkSources(db); const source = (await sources.register([path], "file")).find(item => item.name !== "source.xlsx")!; const [file] = await sources.files(source.id);
  const runId = start(); await flow.submit(runId, getRunAction(db, runId)!.id, { ...input, files: { source: [file] } });
  const name = vi.mocked(tool.execute).mock.calls[0][0].files.source[0].name;
  expect(name).toBe("케찹이_데모.xlsx".normalize("NFC")); expect(name).not.toBe(nfd);
});
