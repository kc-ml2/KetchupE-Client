// @vitest-environment node
import { expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import { createExcelTool } from "./tool.ts";
import { comparisonFixture, fixturePlan, fixtureReport, fixtureWorkbook } from "./fixtures.ts";
import { profileWorkbook, readAnalysisInputs } from "./workbook.ts";
import { runAnalysis } from "./sandbox.ts";
import { renderHtml, renderXlsx } from "./render.ts";
import type { ExcelDependencies } from "./tool.ts";
import type { OutputFormat } from "./contracts.ts";

async function setup(format: OutputFormat = "html") {
  const plan = { ...fixturePlan, format };
  const deps: ExcelDependencies = {
    complete: vi.fn().mockResolvedValueOnce(JSON.stringify(plan)).mockResolvedValue(JSON.stringify({ kind: "finish", summary: "두 날짜의 분석 결과입니다." })),
    profile: (bytes, _signal, query, inspection) => profileWorkbook(bytes, query, inspection),
    analyze: vi.fn(async (files, p) => { const { rows, blankRows, sourceNotes, rowSources } = await readAnalysisInputs(files, p); return { result: await runAnalysis(p.code, rows), rowCount: rows.length, blankRows, sourceNotes, rowSources }; }),
    export: vi.fn(async (report, kind) => kind === "html" ? Buffer.from(renderHtml(report)) : renderXlsx(report)),
    pdf: vi.fn(async () => Buffer.from("%PDF-1.7\nfixture\n%%EOF")),
  };
  const input = { files: { source: [{ bytes: Buffer.from(await fixtureWorkbook()), fingerprint: "a".repeat(64), name: "실험.xlsx" }] }, values: { request: "일별 인장강도를 정리해줘", format }, checkpoint: {}, signal: new AbortController().signal, onProgress: vi.fn() };
  return { deps, input, tool: createExcelTool(deps) };
}

it("analyzes a styled multi-sheet workbook over the old preview limit without splitting files", async () => {
  const { deps, input, tool } = await setup();
  const book = new ExcelJS.Workbook();
  for (let i = 0; i < 4; i++) {
    const sheet = book.addWorksheet(`실험${i}`);
    for (let row = 1; row <= 25; row++) for (let col = 1; col <= 40; col++) {
      const cell = sheet.getRow(row).getCell(col);
      cell.value = row === 1 ? `측정${col}` : row * col;
      cell.numFmt = "#,##0.00";
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFCC00" } };
      cell.font = { color: { argb: "FF123456" } };
    }
    sheet.getCell("B2").value = { formula: "A2*2", result: 4 };
  }
  input.files.source[0].bytes = Buffer.from(await book.xlsx.writeBuffer());
  const originalProfile = deps.profile;
  let initialSize = 0;
  deps.profile = async (...args) => { const result = await originalProfile(...args); if (!args[3]) initialSize = JSON.stringify(result).length; return result; };
  const plan = { ...fixturePlan, inputs: [{ fileId: "file1", sheet: "실험3", headerRow: 1, firstDataRow: 2, lastDataRow: 2, columns: [{ index: 2, name: "측정2", key: "c2" }] }],
    code: 'return {tables:[{title:"값",columns:["값"],rows:input.rows.map(r=>({cells:[r.values.c2],sourceRows:[r.id]}))}],excluded:[],notes:[],chart:null};' };
  vi.mocked(deps.complete).mockReset()
    .mockResolvedValueOnce(JSON.stringify({ kind: "inspect", fileId: "file1", sheet: "실험3", query: "", startRow: 1, endRow: 2, startColumn: 1, endColumn: 2 }))
    .mockResolvedValueOnce(JSON.stringify(plan)).mockResolvedValue(JSON.stringify({ kind: "finish", summary: "측정값은 4입니다." }));
  expect(await tool.execute(input)).toMatchObject({ status: "completed" });
  expect(initialSize).toBeGreaterThan(200000);
  const prompts = vi.mocked(deps.complete).mock.calls.map(call => JSON.parse(call[1]));
  expect(prompts[0].profile[0].sheets.map((sheet: { name: string }) => sheet.name)).toEqual(["실험0", "실험1", "실험2", "실험3"]);
  expect(prompts[1].inspections[0].sheets[0].metadata.B2).toMatchObject({ formula: "A2*2", display: "4.00", numFmt: "#,##0.00" });
  for (const prompt of prompts) expect(JSON.stringify({ profile: prompt.profile, inspections: prompt.inspections }).length).toBeLessThan(200000);
  expect(vi.mocked(deps.export).mock.calls[0][0].result.tables[0].rows[0].cells).toEqual([4]);
});

it("evicts older inspection details and permits reading them again instead of failing the job", async () => {
  const { deps, input, tool } = await setup();
  const originalProfile = deps.profile;
  const calls: number[] = [];
  deps.profile = async (bytes, signal, query, inspection) => {
    const result = await originalProfile(bytes, signal, query);
    if (inspection) {
      calls.push(inspection.startRow!);
      const sheet = result.sheets[0];
      sheet.preview = Array.from({ length: 40 }, (_, i) => ({ row: i + 1, cells: [i] }));
      sheet.metadata = Object.fromEntries(sheet.preview.map(row => [`A${row.row}`, { numFmt: "0", display: String(row.row), formula: "1+".repeat(2000) + "1" }]));
    }
    return result;
  };
  vi.mocked(deps.complete).mockReset();
  for (const startRow of [1, 2, 1]) vi.mocked(deps.complete).mockResolvedValueOnce(JSON.stringify({ kind: "inspect", fileId: "file1", sheet: "실험", query: "", startRow }));
  vi.mocked(deps.complete).mockResolvedValueOnce(JSON.stringify(fixturePlan)).mockResolvedValue(JSON.stringify({ kind: "finish", summary: "확인 완료" }));
  expect(await tool.execute(input)).toMatchObject({ status: "completed" });
  expect(calls).toEqual([1, 2, 1]);
  const prompt = JSON.parse(vi.mocked(deps.complete).mock.calls[3][1]);
  expect(prompt.inspections).toHaveLength(1);
  expect(prompt.inspections[0].range.startRow).toBe(1);
  expect(prompt.failure).toBe("");
});

it("repairs repeated header keys and code together without asking the user to edit the workbook", async () => {
  const { deps, input, tool } = await setup();
  const book = new ExcelJS.Workbook();
  book.addWorksheet("실험").addRows([["금액", "금액"], [100, 30]]);
  input.files.source[0].bytes = Buffer.from(await book.xlsx.writeBuffer());
  const invalid = { ...fixturePlan, inputs: [{ ...fixturePlan.inputs[0], columns: [{ index: 1, name: "금액" }, { index: 2, name: "금액" }] }] };
  const repaired = { ...invalid, inputs: [{ ...invalid.inputs[0], columns: invalid.inputs[0].columns.map(c => ({ ...c, key: `c${c.index}` })) }],
    code: 'return {tables:[{title:"차액",columns:["차액"],rows:input.rows.map(r=>({cells:[r.values.c1-r.values.c2],sourceRows:[r.id]}))}],excluded:[],notes:[],chart:null};' };
  vi.mocked(deps.complete).mockReset().mockResolvedValueOnce(JSON.stringify(invalid)).mockResolvedValueOnce(JSON.stringify(repaired)).mockResolvedValue(JSON.stringify({ kind: "finish", summary: "차액은 70입니다." }));
  const result = await tool.execute(input);
  expect(result.status).toBe("completed");
  expect(vi.mocked(deps.complete).mock.calls[1][1]).toContain("서로 다른 key");
  expect(deps.analyze).toHaveBeenCalledTimes(2);
  const report = vi.mocked(deps.export).mock.calls[0][0];
  expect(report.result.tables[0].rows[0].cells).toEqual([70]);
});

it.each(["html", "xlsx", "pdf"] as const)("creates the requested %s format from the same computed result", async (format) => {
  const { tool, input, deps } = await setup(format);
  const result = await tool.execute(input);
  expect(result).toMatchObject({ status: "completed", file: { name: `${fixturePlan.title}.${format}` } });
  if (result.status !== "completed") throw new Error("not completed");
  expect(result.summary).toContain("54.5"); expect(result.summary).toContain("60행");
  expect(input.onProgress).toHaveBeenCalledWith(expect.stringContaining("분석 계획"));
  if (format !== "xlsx") await tool.validateOutput!(result.file, input.signal);
  expect(deps.pdf).toHaveBeenCalledTimes(format === "pdf" ? 1 : 0);
});

it("asks about an unspecified format without executing analysis", async () => {
  const { deps, tool, input } = await setup();
  input.values.format = "" as OutputFormat;
  vi.mocked(deps.complete).mockReset().mockResolvedValue('{"kind":"ask","reason":"format","question":"PDF, HTML, 엑셀 중 어떤 형식으로 만들까요?"}');
  expect(await tool.execute(input)).toMatchObject({ status: "needs_input", fields: [{ key: "answer1" }] });
  expect(deps.analyze).not.toHaveBeenCalled();
});

it("redirects permission-only questions into execution without asking the user again", async () => {
  const { deps, input, tool } = await setup();
  vi.mocked(deps.complete).mockReset()
    .mockResolvedValueOnce(JSON.stringify({ kind: "ask", reason: "confirmation", question: "이미 확인된 원화·외화 합계를 기반으로 엑셀 파일 생성을 바로 진행하겠습니다. 진행해도 되는지 확인 부탁드립니다." }))
    .mockResolvedValueOnce(JSON.stringify(fixturePlan))
    .mockResolvedValue(JSON.stringify({ kind: "finish", summary: "완료" }));
  expect(await tool.execute(input)).toMatchObject({ status: "completed" });
  expect(JSON.parse(vi.mocked(deps.complete).mock.calls[1][1]).failure).toContain("진행 승인을 다시 묻지 말고");
  expect(deps.analyze).toHaveBeenCalledTimes(1);
});

it("still asks about unresolved conversion criteria even if the question mentions proceeding", async () => {
  const { deps, input, tool } = await setup();
  const question = "외화를 원화로 변환할 때 어떤 환율 기준으로 진행할까요?";
  vi.mocked(deps.complete).mockReset().mockResolvedValue(JSON.stringify({ kind: "ask", reason: "criteria", question }));
  expect(await tool.execute(input)).toMatchObject({ status: "needs_input", question });
  expect(deps.analyze).not.toHaveBeenCalled();
});

it("persists question-answer pairs and searches the full workbook using the user's answer", async () => {
  const { deps, input, tool } = await setup();
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("실험");
  sheet.addRow(["항목", "금액"]);
  sheet.getRow(75).values = ["대여금", 100];
  input.files.source[0].bytes = Buffer.from(await book.xlsx.writeBuffer());
  vi.mocked(deps.complete).mockReset().mockResolvedValue('{"kind":"ask","reason":"criteria","question":"어떤 항목을 정리할까요?"}');
  const first = await tool.execute(input);
  if (first.status !== "needs_input") throw new Error("not waiting");
  await tool.execute({ ...input, checkpoint: first.checkpoint!, values: { ...input.values, answer1: "대여금" } });
  const prompt = JSON.parse(vi.mocked(deps.complete).mock.calls[1][1]);
  expect(prompt.clarifications).toEqual([{ key: "answer1", question: "어떤 항목을 정리할까요?", answer: "대여금" }]);
  expect(prompt.profile[0].sheets[0].search.shownMatchRows).toContain(75);
  expect(prompt.profile[0].sheets[0].preview.find((row: { row: number }) => row.row === 75).cells).toEqual(["대여금", 100]);
  expect(JSON.parse(vi.mocked(deps.complete).mock.calls[2][1]).failure).toContain("이미 받은 답변");
});

it("resumes with H 243 as a location and delivers its surrounding cells to the planner", async () => {
  const { deps, input, tool } = await setup();
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("자금");
  sheet.getCell("H242").value = "항목"; sheet.getCell("I242").value = "금액";
  sheet.getCell("H243").value = "대여금"; sheet.getCell("I243").value = 100;
  input.files.source[0].bytes = Buffer.from(await book.xlsx.writeBuffer());
  vi.mocked(deps.complete).mockReset().mockResolvedValueOnce('{"kind":"ask","reason":"criteria","question":"분석할 항목은 무엇인가요?"}');
  const first = await tool.execute(input);
  if (first.status !== "needs_input") throw new Error("not waiting");
  const plan = { ...fixturePlan, inputs: [{ fileId: "file1", sheet: "자금", headerRow: 242, firstDataRow: 243, columns: [{ index: 8, name: "항목", key: "c8" }, { index: 9, name: "금액", key: "c9" }] }],
    code: 'return {tables:[{title:"자금",columns:["항목","금액"],rows:input.rows.map(r=>({cells:[r.values.c8,r.values.c9],sourceRows:[r.id]}))}],excluded:[],notes:[],chart:null};' };
  vi.mocked(deps.complete).mockResolvedValueOnce(JSON.stringify(plan)).mockResolvedValue(JSON.stringify({ kind: "finish", summary: "요약" }));
  expect(await tool.execute({ ...input, checkpoint: first.checkpoint!, values: { ...input.values, answer1: "H 243부터" } })).toMatchObject({ status: "completed" });
  const prompt = JSON.parse(vi.mocked(deps.complete).mock.calls[1][1]);
  expect(prompt.clarifications).toEqual([{ key: "answer1", question: "분석할 항목은 무엇인가요?", answer: "H 243부터" }]);
  expect(prompt.profile[0].sheets[0].search.requestedCells).toEqual([{ address: "H243", row: 243, column: 8, inBounds: true }]);
  expect(prompt.profile[0].sheets[0].preview.find((row: { row: number }) => row.row === 243).cells.slice(7)).toEqual(["대여금", 100]);
  expect(vi.mocked(deps.export).mock.calls[0][0].result.tables[0].rows[0].cells).toEqual(["대여금", 100]);
});

it("rechecks repeated clarification requests and lets the user continue the same run after three answers", async () => {
  const { deps, input, tool } = await setup();
  const values = { ...input.values, answer1: "실험", answer2: "실험일", answer3: "인장강도" };
  const checkpoint = { clarifications: [{ key: "answer3", question: "어떤 측정값인가요?" }] };
  const question = '{"kind":"ask","reason":"criteria","question":"어떤 측정값인가요?"}';
  vi.mocked(deps.complete).mockReset().mockResolvedValueOnce(question).mockResolvedValueOnce(JSON.stringify(fixturePlan)).mockResolvedValue(JSON.stringify({ kind: "finish", summary: "요약" }));
  expect(await tool.execute({ ...input, values, checkpoint })).toMatchObject({ status: "completed" });
  expect(deps.complete).toHaveBeenCalledTimes(3);
  vi.mocked(deps.complete).mockReset().mockResolvedValue(question);
  const unresolved = await tool.execute({ ...input, values, checkpoint });
  expect(unresolved).toMatchObject({ status: "needs_input", fields: [{ key: "answer3", label: "확인 내용 보완" }] });
  if (unresolved.status !== "needs_input") throw new Error("not waiting");
  expect(unresolved.question).not.toContain("새 작업");
  expect(unresolved.checkpoint!.clarifications).toEqual([
    { key: "answer3", question: "어떤 측정값인가요?", answer: "인장강도" },
    { key: "answer3", question: "어떤 측정값인가요?" },
  ]);
  expect(deps.complete).toHaveBeenCalledTimes(2);
});

it.each([65, 243, 517])("searches and inspects relocated tables at row %s without user coordinates", async dataRow => {
  const { deps, input, tool } = await setup();
  input.values.request = "빌려준 돈을 HTML로 정리해줘";
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("자금");
  for (let row = 1; row < dataRow - 6; row++) sheet.getCell(`A${row}`).value = "반복 안내";
  sheet.getCell(`H${dataRow - 6}`).value = "항목";
  sheet.getCell(`I${dataRow - 6}`).value = "금액";
  sheet.getCell(`H${dataRow}`).value = "대여금";
  sheet.getCell(`I${dataRow}`).value = 100;
  input.files.source[0].bytes = Buffer.from(await book.xlsx.writeBuffer());
  const plan = { ...fixturePlan, inputs: [{ fileId: "file1", sheet: "자금", headerRow: dataRow - 6, firstDataRow: dataRow, columns: [{ index: 8, name: "항목", key: "c8" }, { index: 9, name: "금액", key: "c9" }] }],
    code: 'return {tables:[{title:"자금",columns:["항목","금액"],rows:input.rows.map(r=>({cells:[r.values.c8,r.values.c9],sourceRows:[r.id]}))}],excluded:[],notes:[],chart:null};' };
  vi.mocked(deps.complete).mockReset()
    .mockResolvedValueOnce('{"kind":"ask","reason":"location","question":"정확한 행 번호를 알려주세요."}')
    .mockResolvedValueOnce('{"kind":"inspect","fileId":"file1","sheet":"자금","query":"대여금"}')
    .mockResolvedValueOnce(JSON.stringify({ kind: "inspect", fileId: "file1", sheet: "자금", query: "", startRow: dataRow - 6 }))
    .mockResolvedValueOnce(JSON.stringify(plan)).mockResolvedValue(JSON.stringify({ kind: "finish", summary: "대여금은 100입니다." }));
  expect(await tool.execute(input)).toMatchObject({ status: "completed" });
  const initial = JSON.parse(vi.mocked(deps.complete).mock.calls[0][1]);
  expect(initial.profile[0].sheets[0].outline.entries).toContainEqual({ row: dataRow, text: `H${dataRow}: 대여금 | I${dataRow}: 100` });
  const searched = JSON.parse(vi.mocked(deps.complete).mock.calls[2][1]);
  expect(searched.inspections[0].sheets[0].search.shownMatchRows).toContain(dataRow);
  const inspected = JSON.parse(vi.mocked(deps.complete).mock.calls[3][1]);
  expect(inspected.inspections).toHaveLength(2);
  expect(inspected.inspectionBudget).toBe(10);
  expect(inspected.inspections[1].sheets[0].preview[0].cells.slice(7)).toEqual(["항목", "금액"]);
  const report = vi.mocked(deps.export).mock.calls[0][0];
  expect(report.result.tables[0].rows[0].cells).toEqual(["대여금", 100]);
  expect(report.rowSources[1].row).toBe(dataRow);
});

it("bounds inspections, rejects unselected files and does not forward repeated location demands", async () => {
  const { deps, input, tool } = await setup();
  const profile = vi.fn(deps.profile);
  deps.profile = profile;
  vi.mocked(deps.complete).mockReset()
    .mockResolvedValueOnce('{"kind":"inspect","fileId":"file99","sheet":"실험","query":"실험"}')
    .mockResolvedValueOnce(JSON.stringify(fixturePlan)).mockResolvedValue(JSON.stringify({ kind: "finish", summary: "요약" }));
  expect(await tool.execute(input)).toMatchObject({ status: "completed" });
  expect(profile).toHaveBeenCalledTimes(1);
  vi.mocked(deps.complete).mockReset().mockResolvedValue('{"kind":"ask","reason":"location","question":"정확한 행 번호를 알려주세요."}');
  const unresolved = await tool.execute(input);
  expect(unresolved.status).toBe("needs_input");
  if (unresolved.status !== "needs_input") throw new Error("not waiting");
  expect(unresolved.question).not.toContain("행 번호를 알려");
  expect(unresolved.question).toContain("행 번호나 셀 주소는 필요하지 않습니다");
  expect(deps.complete).toHaveBeenCalledTimes(2);
  profile.mockClear();
  vi.mocked(deps.complete).mockReset();
  for (let startRow = 1; startRow <= 13; startRow++) vi.mocked(deps.complete).mockResolvedValueOnce(JSON.stringify({ kind: "inspect", fileId: "file1", sheet: "실험", query: "", startRow }));
  vi.mocked(deps.complete).mockResolvedValueOnce(JSON.stringify(fixturePlan)).mockResolvedValue(JSON.stringify({ kind: "finish", summary: "요약" }));
  expect(await tool.execute(input)).toMatchObject({ status: "completed" });
  expect(profile).toHaveBeenCalledTimes(13); // Initial profile plus twelve inspections.
  expect(JSON.parse(vi.mocked(deps.complete).mock.calls[13][1]).failure).toContain("열람 예산");
});

it("does not repeatedly read an identical inspection and honors cancellation after inspection", async () => {
  const { deps, input, tool } = await setup();
  const inspection = '{"kind":"inspect","fileId":"file1","sheet":"실험","query":"인장강도"}';
  const profile = vi.fn(deps.profile);
  deps.profile = profile;
  vi.mocked(deps.complete).mockReset().mockResolvedValueOnce(inspection).mockResolvedValueOnce(inspection).mockResolvedValueOnce(JSON.stringify(fixturePlan)).mockResolvedValue(JSON.stringify({ kind: "finish", summary: "요약" }));
  expect(await tool.execute(input)).toMatchObject({ status: "completed" });
  expect(profile).toHaveBeenCalledTimes(2);
  const reused = JSON.parse(vi.mocked(deps.complete).mock.calls[2][1]);
  expect(reused.failure).toBe("");
  expect(reused.previous.reusedInspection).toBe(true);
  const controller = new AbortController();
  const originalProfile = profile.getMockImplementation()!;
  profile.mockImplementation(async (...args) => { const result = await originalProfile(...args); if (args[3]) controller.abort(); return result; });
  vi.mocked(deps.complete).mockReset().mockResolvedValue(inspection);
  await expect(tool.execute({ ...input, signal: controller.signal })).rejects.toThrow();
  expect(deps.complete).toHaveBeenCalledTimes(1);
});

it("reuses a covered cell range even when the search wording changes, but reads missing cells", async () => {
  const { deps, input, tool } = await setup();
  const profile = vi.fn(deps.profile); deps.profile = profile;
  vi.mocked(deps.complete).mockReset();
  for (const [startRow, endRow, query] of [[1, 10, "강도"], [2, 3, "측정값"], [11, 12, "강도"]] as const) {
    vi.mocked(deps.complete).mockResolvedValueOnce(JSON.stringify({ kind: "inspect", fileId: "file1", sheet: "실험", query, startRow, endRow, startColumn: 1, endColumn: 2 }));
  }
  vi.mocked(deps.complete).mockResolvedValueOnce(JSON.stringify(fixturePlan)).mockResolvedValue(JSON.stringify({ kind: "finish", summary: "완료" }));
  expect(await tool.execute(input)).toMatchObject({ status: "completed" });
  expect(profile).toHaveBeenCalledTimes(3); // Initial profile, first range, and missing range.
  const reused = JSON.parse(vi.mocked(deps.complete).mock.calls[2][1]);
  expect(reused.previous.reusedInspection).toBe(true);
  expect(reused.inspectionBudget).toBe(11);
});

it("can inspect, compute, inspect the result and recalculate before finishing", async () => {
  const { deps, input, tool } = await setup();
  const revised = { ...fixturePlan, title: "검토 후 수정" };
  vi.mocked(deps.complete).mockReset()
    .mockResolvedValueOnce(JSON.stringify(fixturePlan))
    .mockResolvedValueOnce('{"kind":"inspect_result","table":0,"startRow":2,"endRow":2}')
    .mockResolvedValueOnce('{"kind":"inspect","fileId":"file1","sheet":"실험","query":"","startRow":30,"endRow":35}')
    .mockResolvedValueOnce(JSON.stringify(revised))
    .mockResolvedValueOnce('{"kind":"finish","summary":"전체 결과와 근거를 다시 확인했습니다."}');
  expect(await tool.execute(input)).toMatchObject({ status: "completed" });
  expect(deps.analyze).toHaveBeenCalledTimes(2);
  expect(JSON.parse(vi.mocked(deps.complete).mock.calls[1][1]).computed.tables[0].totalRows).toBe(2);
  expect(JSON.parse(vi.mocked(deps.complete).mock.calls[2][1]).resultPage.rows[0].cells[1]).toBe(84.5);
  expect(vi.mocked(deps.export).mock.calls[0][0].plan.title).toBe("검토 후 수정");
});

it("exports multiple requested formats only after review and preserves all evidence", async () => {
  const { deps, input, tool } = await setup();
  vi.mocked(deps.complete).mockReset()
    .mockResolvedValueOnce(JSON.stringify({ ...fixturePlan, formats: ["html", "xlsx", "pdf"], layout: "dashboard" }))
    .mockResolvedValueOnce('{"kind":"finish","summary":"검토 완료","sections":[{"title":"주간 결과","text":"상세 설명"}]}');
  const result = await tool.execute(input);
  expect(result).toMatchObject({ status: "completed", additionalFiles: [{ name: expect.stringMatching(/\.xlsx$/) }, { name: expect.stringMatching(/\.pdf$/) }] });
  if (result.status !== "completed") throw new Error("not completed");
  await tool.validateOutput!(result.file, input.signal);
  expect(Buffer.from(result.file.bytes).toString()).toContain("data-filter");
  expect(Buffer.from(result.file.bytes).toString()).toContain("주간 결과");
  expect(vi.mocked(deps.pdf).mock.calls[0][0]).not.toContain("<script>");
});

it("repairs code and applies the explicitly selected format without another model turn", async () => {
  const { deps, input, tool } = await setup();
  vi.mocked(deps.complete).mockReset().mockResolvedValueOnce(JSON.stringify({ ...fixturePlan, code: "return missing;" })).mockResolvedValueOnce(JSON.stringify(fixturePlan)).mockResolvedValue(JSON.stringify({ kind: "finish", summary: "요약" }));
  expect(await tool.execute(input)).toMatchObject({ status: "completed" });
  expect(deps.analyze).toHaveBeenCalledTimes(2);
  expect(vi.mocked(deps.complete).mock.calls[1][1]).toContain("missing");
  vi.mocked(deps.complete).mockReset().mockResolvedValueOnce(JSON.stringify({ ...fixturePlan, format: "pdf", formats: ["pdf"] })).mockResolvedValue(JSON.stringify({ kind: "finish", summary: "요약" }));
  expect(await tool.execute(input)).toMatchObject({ status: "completed", file: { name: expect.stringMatching(/\.html$/) } });
  expect(deps.complete).toHaveBeenCalledTimes(2);
  expect(deps.pdf).not.toHaveBeenCalled();
});

it("preserves results on export failure and changes format without rerunning the model", async () => {
  const { deps, input, tool } = await setup("pdf");
  vi.mocked(deps.pdf).mockRejectedValue(new Error("인쇄 실패"));
  const result = await tool.execute(input);
  expect(result.status).toBe("needs_input");
  if (result.status !== "needs_input") throw new Error("not waiting");
  expect(result.checkpoint!.report).not.toHaveProperty("result");
  expect(result.checkpoint!.excelState).toHaveProperty("latest.analysis.result");
  const calls = vi.mocked(deps.complete).mock.calls.length;
  vi.mocked(deps.export).mockRejectedValueOnce(new Error("재출력 실패"));
  const failedRetry = await tool.execute({ ...input, checkpoint: result.checkpoint!, values: { ...input.values, exportFormat: "xlsx" } });
  expect(failedRetry.status).toBe("needs_input");
  if (failedRetry.status !== "needs_input") throw new Error("not waiting");
  expect(failedRetry.checkpoint!.report).not.toHaveProperty("result");
  const resumed = await tool.execute({ ...input, checkpoint: failedRetry.checkpoint!, values: { ...input.values, exportFormat: "xlsx" } });
  expect(resumed).toMatchObject({ status: "completed", file: { name: `${fixturePlan.title}.xlsx` } });
  if (resumed.status !== "completed") throw new Error("not completed");
  expect(resumed.checkpoint).toHaveProperty("excelState.latest.plan.formats", ["xlsx"]);
  expect(resumed.checkpoint).toHaveProperty("excelState.latest.analysis.result");
  expect(deps.complete).toHaveBeenCalledTimes(calls);
});

it("does not export unreviewed results when the review model fails, and honors cancellation", async () => {
  const { deps, input, tool } = await setup();
  vi.mocked(deps.complete).mockReset().mockResolvedValueOnce(JSON.stringify(fixturePlan)).mockRejectedValue(new Error("offline"));
  await expect(tool.execute(input)).rejects.toThrow("offline");
  expect(deps.export).not.toHaveBeenCalled();
  const abort = new AbortController(); abort.abort();
  await expect(tool.execute({ ...input, signal: abort.signal, checkpoint: { report: fixtureReport }, values: { ...input.values, exportFormat: "pdf" } })).rejects.toThrow();
});

it("profiles every file, supports multiple selection and protects every source during export retries", async () => {
  const { tool, input, deps } = await setup("pdf");
  const { files, plan } = await comparisonFixture();
  input.files.source = files.map(file => ({ ...file, bytes: Buffer.from(file.bytes) }));
  vi.mocked(deps.complete).mockReset().mockResolvedValueOnce(JSON.stringify({ ...plan, format: "pdf" })).mockResolvedValue(JSON.stringify({ kind: "finish", summary: "비교 결과" }));
  vi.mocked(deps.pdf).mockRejectedValueOnce(new Error("인쇄 실패"));
  expect(tool.fields.find(f => f.key === "source")?.multiple).toBe(true);
  const result = await tool.execute(input);
  const profile = JSON.parse(vi.mocked(deps.complete).mock.calls[0][1]).profile;
  expect(profile.map((p: { fileId: string; name: string }) => [p.fileId, p.name])).toEqual([["file1", "실험.xlsx"], ["file2", "실험.xlsx"]]);
  expect(profile[1].sheets).toHaveLength(2);
  if (result.status !== "needs_input") throw new Error("not waiting");
  const resumed = { ...input, checkpoint: result.checkpoint!, values: { ...input.values, exportFormat: "html" } };
  await expect(tool.execute({ ...resumed, files: { source: [input.files.source[0], { ...input.files.source[1], fingerprint: "changed" }] } })).rejects.toThrow("원본이 변경");
  await expect(tool.execute({ ...resumed, files: { source: input.files.source.slice(0, 1) } })).rejects.toThrow("원본이 변경");
  const exported = await tool.execute(resumed);
  expect(exported.status).toBe("completed");
  if (exported.status === "completed") expect(Buffer.from(exported.file.bytes).toString()).toContain("[file2] 실험.xlsx / 기준: 2행");
  expect(deps.complete).toHaveBeenCalledTimes(2);
  expect(deps.analyze).toHaveBeenCalledTimes(1);
});

it("routes every worker job of a submission through one session and closes it, even on failure", async () => {
  const { deps, input, tool } = await setup();
  const close = vi.fn();
  const { profile, analyze } = deps;
  deps.session = () => ({ profile, analyze, export: deps.export, close });
  deps.profile = vi.fn(async () => { throw new Error("one-shot path used"); });
  expect(await tool.execute(input)).toMatchObject({ status: "completed" });
  expect(close).toHaveBeenCalledOnce();
  vi.mocked(deps.complete).mockReset().mockRejectedValue(new Error("offline"));
  await expect(tool.execute(input)).rejects.toThrow("offline");
  expect(close).toHaveBeenCalledTimes(2);
});

it("finishes a simple request in one model turn when execute carries a summary", async () => {
  const { deps, input, tool } = await setup();
  vi.mocked(deps.complete).mockReset().mockResolvedValueOnce(JSON.stringify({ ...fixturePlan, summary: "실험일별 평균을 정리했습니다." }));
  const result = await tool.execute(input);
  expect(result).toMatchObject({ status: "completed", checkpoint: { excelState: { latest: { plan: { title: fixturePlan.title } } } } });
  expect(deps.complete).toHaveBeenCalledOnce();
  expect(vi.mocked(deps.export).mock.calls[0][0]).toMatchObject({ summary: "실험일별 평균을 정리했습니다." });
  expect(vi.mocked(deps.export).mock.calls[0][0].plan).not.toHaveProperty("summary");
});

it("still reviews an execute summary whose result has an empty table", async () => {
  const { deps, input, tool } = await setup();
  const empty = `${fixturePlan.code.replace(/^return /m, "const out = ")}\nout.tables.push({title:"빈 표",columns:["값"],rows:[]}); return out;`;
  vi.mocked(deps.complete).mockReset().mockResolvedValueOnce(JSON.stringify({ ...fixturePlan, code: empty, summary: "요약" })).mockResolvedValue(JSON.stringify({ kind: "finish", summary: "검토 완료" }));
  expect(await tool.execute(input)).toMatchObject({ status: "completed" });
  expect(deps.complete).toHaveBeenCalledTimes(2);
});

it("classifies questions by the model's reason, not by wording", async () => {
  const { deps, input, tool } = await setup();
  vi.mocked(deps.complete).mockReset().mockResolvedValue('{"kind":"ask","reason":"location","question":"표가 시작되는 지점을 알려주세요."}');
  const result = await tool.execute(input);
  expect(deps.complete).toHaveBeenCalledTimes(2);
  expect(result).toMatchObject({ status: "needs_input", question: expect.stringContaining("행 번호나 셀 주소는 필요하지 않습니다") });
});
