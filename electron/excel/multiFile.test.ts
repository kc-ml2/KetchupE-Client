// @vitest-environment node
import ExcelJS from "exceljs";
import { expect, it } from "vitest";
import { comparisonFixture } from "./fixtures.ts";
import { analysisPlan, validateResult, type Report } from "./contracts.ts";
import { readAnalysisInputs } from "./workbook.ts";
import { runAnalysis } from "./sandbox.ts";
import { evidenceText, renderHtml, renderXlsx } from "./render.ts";

it("joins two same-named workbooks and three sheets without conflating their row or cell addresses", async () => {
  const { files, plan } = await comparisonFixture();
  const { rows, ...metadata } = await readAnalysisInputs(files, analysisPlan.parse(plan));
  expect(rows.map(r => r.id)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(rows.map(r => r.row)).toEqual([2, 3, 2, 3, 2, 3]);
  expect(rows[0].sourceCells!.인장강도).toBe(rows[2].sourceCells!.강도);
  const result = await runAnalysis(plan.code, rows);
  expect(result.tables[0].rows.map(r => r.cells)).toEqual([["A", 50, 60, 10, 55], ["B", 70, 65, -5, 68]]);
  const report: Report = { ...metadata, result, plan, sources: files.map(({ id, name, fingerprint }) => ({ id, name, fingerprint })), rowCount: rows.length, summary: "소재 A는 10 증가, B는 5 감소했습니다.", createdAt: "2026-10-28T00:00:00Z" };
  const evidence = "[file1] 실험.xlsx / 실험: 2행; [file2] 실험.xlsx / 실험: 2행; [file2] 실험.xlsx / 기준: 2행";
  expect(evidenceText(report, result.tables[0].rows[0].sourceRows)).toBe(evidence);
  expect(renderHtml(report)).toContain(evidence);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(Buffer.from(await renderXlsx(report)) as unknown as ExcelJS.Buffer);
  expect(book.getWorksheet("결과 1")!.getCell("F3").value).toBe(evidence);
  const missing = structuredClone(result);
  missing.tables[0].rows[0].sourceRows.pop();
  expect(() => validateResult(missing, rows)).toThrow("누락");
  missing.tables[0].rows[0].sourceRows.push(999);
  expect(() => validateResult(missing, rows)).toThrow("존재하지");
  const excluded = { ...result, tables: [{ ...result.tables[0], rows: [] }], excluded: rows.map(r => ({ row: r.id, reason: "대상 제외" })), chart: null };
  expect(() => validateResult(excluded, rows)).not.toThrow();
  expect(renderHtml({ ...report, result: excluded })).toContain("[file2] 실험.xlsx / 기준: 3행: 대상 제외");
});

it("rejects unselected and duplicated inputs while allowing omitted files with file-specific errors", async () => {
  const { files, plan } = await comparisonFixture();
  await expect(readAnalysisInputs(files, { ...plan, inputs: [{ ...plan.inputs[0], fileId: "file99" }] })).rejects.toThrow("선택하지 않은 파일");
  expect((await readAnalysisInputs(files, { ...plan, inputs: [plan.inputs[0]] })).sourceNotes.join(" ")).toContain("분석 계획에서 제외");
  await expect(readAnalysisInputs(files, { ...plan, inputs: [...plan.inputs, plan.inputs[0]] })).rejects.toThrow("중복");
  const invalid = structuredClone(plan);
  invalid.inputs[1].sheet = "없는 시트";
  await expect(readAnalysisInputs(files, invalid)).rejects.toThrow("[file2] 실험.xlsx");
  const empty = new ExcelJS.Workbook();
  empty.addWorksheet("실험").addRows([["소재명", "강도"], ["A", { formula: "1+1" }]]);
  await expect(readAnalysisInputs([files[0], { ...files[1], bytes: new Uint8Array(await empty.xlsx.writeBuffer()) }], plan)).rejects.toThrow("[file2] 실험.xlsx: 실험!B2");
});
