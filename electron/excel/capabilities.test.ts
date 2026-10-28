// @vitest-environment node
import ExcelJS from "exceljs";
import { expect, it } from "vitest";
import { profileWorkbook, readAnalysisInputs, readAnalysisRows } from "./workbook.ts";
import { fixturePlan } from "./fixtures.ts";
import { sheetPlan } from "./contracts.ts";

const bytesOf = async (book: ExcelJS.Workbook) => new Uint8Array(await book.xlsx.writeBuffer());

it("reads independent headerless ranges and stops before unrelated errors", async () => {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("자금");
  sheet.getCell("A1").value = 10; sheet.getCell("A2").value = 20;
  sheet.getCell("A3").value = { formula: "1+1" };
  sheet.getCell("AZ20").value = "지출"; sheet.getCell("AZ21").value = 7;
  const bytes = await bytesOf(book);
  const first = sheetPlan.parse({ fileId: "file1", sheet: "자금", rangeId: "income", headerRow: 0, firstDataRow: 1, lastDataRow: 2, columns: [{ index: 1, name: "", key: "amount" }] });
  const second = sheetPlan.parse({ ...first, rangeId: "expense", headerRow: 20, firstDataRow: 21, lastDataRow: 21, columns: [{ index: 52, name: "지출", key: "amount" }] });
  const result = await readAnalysisInputs([{ id: "file1", name: "자금.xlsx", fingerprint: "a", bytes }], { ...fixturePlan, inputs: [first, second] });
  expect(result.rows.map(row => row.values.amount)).toEqual([10, 20, 7]);
  expect(result.rows.map(row => row.rangeId)).toEqual(["income", "income", "expense"]);
  await expect(readAnalysisRows(bytes, { ...first, lastDataRow: 3 })).rejects.toThrow("계산 결과가 없습니다");
  const profile = await profileWorkbook(bytes, "", { sheet: "자금", startRow: 20, endRow: 21, startColumn: 52, endColumn: 52 });
  expect(profile.sheets[0].firstColumn).toBe(52);
  expect(profile.sheets[0].preview.map(row => row.cells)).toEqual([["지출"], [7]]);
});

it("searches numeric codes and one-character labels, including hidden sheets", async () => {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("기준", { state: "hidden" });
  sheet.getCell("A243").value = 123456; sheet.getCell("B243").value = "갑";
  const profile = await profileWorkbook(await bytesOf(book), "123456 갑");
  expect(profile.sheets[0].state).toBe("hidden");
  expect(profile.sheets[0].search.shownMatchRows).toEqual([243]);
});

it.each([false, true])("preserves display, formula, color and timestamps with date1904=%s", async date1904 => {
  const book = new ExcelJS.Workbook(); book.properties.date1904 = date1904;
  const sheet = book.addWorksheet("실험");
  sheet.addRow(["비율", "측정시각", "검토수식"]);
  sheet.getCell("A2").value = { formula: "15/100", result: .15 }; sheet.getCell("A2").numFmt = "0%";
  sheet.getCell("A2").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFF0000" } };
  sheet.getCell("B2").value = new Date("2026-10-28T15:30:00.000Z"); sheet.getCell("B2").numFmt = "yyyy-mm-dd hh:mm";
  sheet.getCell("C2").value = { formula: "1+1" };
  sheet.addConditionalFormatting({ ref: "A2", rules: [{ type: "cellIs", operator: "greaterThan", formulae: [0], priority: 1, style: { font: { bold: true } } }] });
  const bytes = await bytesOf(book), profile = (await profileWorkbook(bytes)).sheets[0];
  expect(profile.metadata.A2).toMatchObject({ display: "15%", formula: "15/100", numFmt: "0%", fill: { fgColor: { argb: "FFFF0000" } } });
  expect(profile.metadata.B2).toMatchObject({ display: "2026-10-28 15:30", dateTime: "2026-10-28T15:30:00.000Z" });
  expect(profile.metadata.C2.formula).toBe("1+1");
  expect(profile.metadata.C2.error).toContain("계산");
  expect(profile.conditionalFormatting).toHaveLength(1);
  const plan = sheetPlan.parse({ ...fixturePlan.inputs[0], allowCellErrors: true, columns: [{ index: 1, name: "비율", key: "ratio" }, { index: 2, name: "측정시각", key: "time" }, { index: 3, name: "검토수식", key: "formula" }] });
  const { rows } = await readAnalysisRows(bytes, plan);
  expect(rows[0].values).toEqual({ ratio: .15, time: "2026-10-28T15:30:00.000Z", formula: null });
  expect(rows[0].metadata?.formula.error).toBeTruthy();
});
