// @vitest-environment node
import ExcelJS from "exceljs";
import { expect, it } from "vitest";
import { fixturePlan, fixtureReport, fixtureWorkbook } from "./fixtures.ts";
import { profileWorkbook, readAnalysisRows } from "./workbook.ts";
import { runAnalysis } from "./sandbox.ts";
import { validateResult } from "./contracts.ts";
import { renderHtml, renderXlsx, sourceRowsText } from "./render.ts";

it("compacts contiguous evidence rows without losing gaps", () => {
  expect(sourceRowsText([5, 2, 3, 4, 9, 10, 12])).toBe("2-5, 9-10, 12");
  expect(sourceRowsText([])).toBe("");
});

it("profiles only a sample but executes generated code over all 60 rows", async () => {
  const bytes = await fixtureWorkbook();
  expect((await profileWorkbook(bytes)).sheets[0].preview).toHaveLength(20);
  const { rows } = await readAnalysisRows(bytes, fixturePlan.inputs[0]);
  const result = await runAnalysis(fixturePlan.code, rows);
  expect(result.tables[0].rows.map((r) => r.cells)).toEqual([["2026-10-19", 54.5, 30], ["2026-10-20", 84.5, 30]]);
  expect(result.tables[0].rows.flatMap((r) => r.sourceRows)).toHaveLength(60);
});

it("runs a different generated filter without changing the executor", async () => {
  const { rows } = await readAnalysisRows(await fixtureWorkbook(), fixturePlan.inputs[0]);
  const result = await runAnalysis(`return {tables:[{title:"미달", columns:["강도"], rows:input.rows.filter(r=>r.values["인장강도"]<50).map(r=>({cells:[r.values["인장강도"]],sourceRows:[r.id]}))}],excluded:input.rows.filter(r=>r.values["인장강도"]>=50).map(r=>({row:r.id,reason:"기준 이상"})),notes:[],chart:null}`, rows);
  expect(result.tables[0].rows).toHaveLength(10);
  expect(result.excluded).toHaveLength(50);
});

it("has no host APIs, interrupts loops, and allows allocations above the former 64MB cap", async () => {
  const { rows } = await readAnalysisRows(await fixtureWorkbook(), fixturePlan.inputs[0]);
  await expect(runAnalysis(`if ([typeof process,typeof require,typeof fetch,typeof console].some(v=>v!=="undefined")) throw new Error("host leak"); ${fixturePlan.code}`, rows)).resolves.toBeDefined();
  await expect(runAnalysis("while(true) {}", rows, 20)).rejects.toThrow("실행 실패");
  await expect(runAnalysis(`const buffer = new ArrayBuffer(72 * 1024 * 1024); new Uint8Array(buffer)[buffer.byteLength - 1] = 1; ${fixturePlan.code}`, rows)).resolves.toBeDefined();
});

it("rejects non-finite numbers, missing rows, invented references and invalid charts", async () => {
  const rows = [2, 3].map(row => ({ id: row, fileId: "file1", sheet: "실험", row, values: { a: row - 1 } }));
  await expect(runAnalysis(`return {x:Infinity}`, rows)).rejects.toThrow("Non-finite");
  const raw = structuredClone(fixtureReport.result);
  raw.tables[0].rows.pop();
  expect(() => validateResult(raw, rows)).toThrow("누락");
  raw.tables[0].rows[0].sourceRows = [999];
  expect(() => validateResult(raw, rows)).toThrow("존재하지");
  const chart = structuredClone(fixtureReport.result);
  chart.chart!.y = 10;
  expect(() => validateResult(chart, rows)).toThrow("차트");
});

it("uses formula caches but still rejects incorrect headers", async () => {
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet("실험");
  sheet.addRows([["실험일", "인장강도"], ["2026-10-19", { formula: "1+1", result: 2 }]]);
  const bytes = new Uint8Array(await book.xlsx.writeBuffer());
  const data = await readAnalysisRows(bytes, fixturePlan.inputs[0]);
  expect(data.rows[0].values["인장강도"]).toBe(2);
  expect(data.sourceNotes.join(" ")).toContain("저장된 계산 결과");
  await expect(readAnalysisRows(bytes, { ...fixturePlan.inputs[0], columns: [{ index: 1, name: "다른 열" }] })).rejects.toThrow("헤더");
});

it("escapes HTML content and exports XLSX with typed values, evidence and no executable formulas", async () => {
  const report = structuredClone(fixtureReport);
  report.sourceNotes = ["수식의 저장된 계산 결과 사용 · 병합 기준 셀 확인"];
  report.summary = '<script>alert("x")</script><img src="https://outside.test">';
  report.result.tables[0].rows[0].cells[0] = '=HYPERLINK("https://outside.test")';
  const html = renderHtml(report);
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toMatch(/<script|<img/);
  expect(html).toContain("default-src 'none'");
  expect(html).toContain(report.sourceNotes[0]);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(Buffer.from(await renderXlsx(report)) as unknown as ExcelJS.Buffer);
  expect(book.getWorksheet("결과 1")!.getCell("A3").value).toBe(report.result.tables[0].rows[0].cells[0]);
  expect(book.getWorksheet("결과 1")!.getCell("A3").type).toBe(ExcelJS.ValueType.String);
  expect(book.getWorksheet("결과 1")!.getCell("B3").value).toBe(50);
  expect(book.getWorksheet("결과 1")!.getCell("C3").value).toBe("[file1] 실험.xlsx / 실험: 2행");
  expect(book.getWorksheet("차트 1")).toBeTruthy();
  expect(book.getWorksheet("분석 안내")!.getSheetValues().flat()).toContain(report.sourceNotes[0]);
});
