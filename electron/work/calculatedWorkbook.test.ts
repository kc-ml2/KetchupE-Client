// @vitest-environment node
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { expect, it } from "vitest";
import { SelectiveWorkbook } from "./selectiveWorkbook.ts";
import { textFitArea } from "./textFit.ts";

async function fixture() {
  const book = new ExcelJS.Workbook();
  book.addWorksheet("prior").getCell("A1").value = 100;
  const sheet = book.addWorksheet("current");
  sheet.getCell("A1").value = 100;
  sheet.getCell("B1").value = { formula: "A1=prior!A1" };
  sheet.getCell("C1").value = { formula: "A1*2", result: 0 };
  sheet.mergeCells("C1:D1");
  const bytes = new Uint8Array(await book.xlsx.writeBuffer());
  return { bytes, archive: await SelectiveWorkbook.open(bytes), sheet };
}

it("updates boolean and numeric caches without changing formulas, styles or historical XML", async () => {
  const { bytes, archive, sheet } = await fixture();
  sheet.getCell("B1").value = { formula: "A1=prior!A1", result: true } as unknown as ExcelJS.CellValue;
  sheet.getCell("C1").value = { formula: "A1*2", result: 200 };
  const output = await archive.withCalculatedValues(sheet, ["B1"]);
  const oldZip = await JSZip.loadAsync(bytes), newZip = await JSZip.loadAsync(output);
  for (const path of ["xl/worksheets/sheet1.xml", "xl/styles.xml", "xl/workbook.xml"]) expect(await newZip.file(path)!.async("string")).toBe(await oldZip.file(path)!.async("string"));
  const current = (await (await SelectiveWorkbook.open(output)).loadSheet("current")).getWorksheet("current")!;
  expect(current.getCell("B1").result).toBe(true);
  expect(current.getCell("C1").value).toEqual({ formula: "A1*2", result: 200 });
  expect(current.model.merges).toEqual(["C1:D1"]);
});

it.each(["missing", "error", "false", "formula", "input"])("refuses a %s calculation result", async (kind) => {
  const { archive, sheet } = await fixture();
  sheet.getCell("B1").value = { formula: "A1=prior!A1", result: true } as unknown as ExcelJS.CellValue;
  if (kind === "missing") sheet.getCell("C1").value = { formula: "A1*2" };
  if (kind === "error") sheet.getCell("C1").value = { formula: "A1*2", result: { error: "#REF!" } };
  if (kind === "false") sheet.getCell("B1").value = { formula: "A1=prior!A1", result: false } as unknown as ExcelJS.CellValue;
  if (kind === "formula") sheet.getCell("C1").value = { formula: "A1*3", result: 300 };
  if (kind === "input") sheet.getCell("A1").value = 999;
  await expect(archive.withCalculatedValues(sheet, ["B1"])).rejects.toThrow();
});

it.each([false, true])("preserves date-formula caches using the workbook's date system (1904: %s)", async (date1904) => {
  const book = new ExcelJS.Workbook(); book.properties.date1904 = date1904;
  const sheet = book.addWorksheet("current");
  sheet.getCell("A1").value = { formula: "DATE(2026,11,5)" };
  sheet.getCell("A1").numFmt = "yyyy-mm-dd";
  const archive = await SelectiveWorkbook.open(new Uint8Array(await book.xlsx.writeBuffer()));
  const date = new Date("2026-11-05T00:00:00Z");
  sheet.getCell("A1").value = { formula: "DATE(2026,11,5)", result: date } as unknown as ExcelJS.CellValue;
  const output = await SelectiveWorkbook.open(await archive.withCalculatedValues(sheet, []));
  expect((await output.loadSheet("current")).getWorksheet("current")!.getCell("A1").result).toEqual(date);
});

it("accepts native text encoding and 15-digit normalization while retaining the exact source inputs", async () => {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("current");
  sheet.getCell("A1").value = "일일자금일보\n2026.10.14";
  sheet.getCell("B1").value = 177119320840.27878;
  const archive = await SelectiveWorkbook.open(new Uint8Array(await book.xlsx.writeBuffer()));
  sheet.getCell("A1").value = { richText: [{ font: { name: "Arial" }, text: "일일자금일보\n" }, { text: "2026.10.14" }] };
  sheet.getCell("B1").value = 177119320840.279;
  const output = await SelectiveWorkbook.open(await archive.withCalculatedValues(sheet, []));
  const final = (await output.loadSheet("current")).getWorksheet("current")!;
  expect(final.getCell("A1").value).toBe("일일자금일보\n2026.10.14");
  expect(final.getCell("B1").value).toBe(177119320840.27878);
  sheet.getCell("B1").value = 177119320840.29;
  await expect(archive.withCalculatedValues(sheet, [])).rejects.toThrow("입력값");
  sheet.getCell("B1").value = 177119320840.279;
  sheet.getCell("A1").value = { richText: [{ text: "changed" }] };
  await expect(archive.withCalculatedValues(sheet, [])).rejects.toThrow("입력값");
});

it("accepts Calc's singleton SUM and numeric true only in LibreOffice mode, preserving source formulas", async () => {
  const { bytes, sheet } = await fixture();
  sheet.getCell("C1").value = { formula: "SUM(A1:A1)", result: 100 };
  const source = new ExcelJS.Workbook(); await source.xlsx.load(Buffer.from(bytes) as unknown as ExcelJS.Buffer);
  source.getWorksheet("current")!.getCell("C1").value = { formula: "SUM(A1:A1)" };
  const archive = await SelectiveWorkbook.open(new Uint8Array(await source.xlsx.writeBuffer()));
  sheet.getCell("B1").value = { formula: "A1=prior!A1", result: 1 };
  sheet.getCell("C1").value = { formula: "SUM(A1)", result: 100 };
  await expect(archive.withCalculatedValues(sheet, ["B1"])).rejects.toThrow();
  const output = await SelectiveWorkbook.open(await archive.withCalculatedValues(sheet, ["B1"], "LibreOffice"));
  const current = (await output.loadSheet("current")).getWorksheet("current")!;
  expect(current.getCell("B1").result).toBe(true);
  expect(current.getCell("C1").value).toEqual({ formula: "SUM(A1:A1)", result: 100 });
  sheet.getCell("B1").value = { formula: "A1=prior!A1", result: 0 };
  await expect(archive.withCalculatedValues(sheet, ["B1"], "LibreOffice")).rejects.toThrow("일치하지 않습니다");
});

it.each([
  ['SUM(A1:A2)', 'SUM(A1)'],
  ['"SUM(A1:A1)"', '"SUM(A1)"'],
  ["'SUM(A1:A1)'!A1", "'SUM(A1)'!A1"],
  ['AVERAGE(A1:A1)', 'AVERAGE(A1)'],
])("rejects changed formulas in LibreOffice: %s → %s", async (original, changed) => {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("current");
  sheet.getCell("B1").value = { formula: original };
  const archive = await SelectiveWorkbook.open(new Uint8Array(await book.xlsx.writeBuffer()));
  sheet.getCell("B1").value = { formula: changed, result: 1 };
  await expect(archive.withCalculatedValues(sheet, [], "LibreOffice")).rejects.toThrow("수식이 변경");
});

it("imports measured wrapping, merges and height while retaining every original style and input", async () => {
  const book = new ExcelJS.Workbook();
  book.addWorksheet("prior").getCell("A1").value = "history";
  const sheet = book.addWorksheet("current");
  sheet.getCell("B4").value = "A long description / company name";
  sheet.getCell("B4").font = { name: "Arial", size: 11 };
  sheet.getCell("B4").alignment = { horizontal: "left", vertical: "top", indent: 1 };
  sheet.getCell("C4").font = { name: "Courier New", italic: true };
  sheet.getCell("C4").border = { right: { style: "double" } };
  sheet.getCell("D4").value = 1234;
  sheet.getRow(4).height = 15;
  sheet.getCell("B5").value = "short";
  sheet.getRow(5).height = 21;
  const bytes = new Uint8Array(await book.xlsx.writeBuffer());
  const archive = await SelectiveWorkbook.open(bytes);
  const originalStyle = structuredClone((await archive.loadSheet("current")).getWorksheet("current")!.getCell("B4").style);
  sheet.mergeCells("B4:C4");
  sheet.getCell("B4").alignment = { wrapText: true };
  sheet.getCell("B4").font = { name: "different native font", size: 7 };
  sheet.getRow(4).height = 36;
  const output = await archive.withCalculatedValues(sheet, [], "LibreOffice", ["B4:C4"]);
  const final = (await (await SelectiveWorkbook.open(output)).loadSheet("current")).getWorksheet("current")!;
  expect(final.getCell("B4").value).toBe("A long description / company name");
  expect(final.getCell("B4").style).toEqual({ ...originalStyle, alignment: { ...originalStyle.alignment, wrapText: true } });
  expect(final.getCell("D4").value).toBe(1234);
  expect(final.getRow(4).height).toBe(36);
  expect(final.getRow(5).height).toBe(21);
  expect(final.model.merges).toEqual(["B4:C4"]);
  const beforeZip = await JSZip.loadAsync(bytes), afterZip = await JSZip.loadAsync(output);
  const beforeXml = await beforeZip.file("xl/worksheets/sheet2.xml")!.async("string"), afterXml = await afterZip.file("xl/worksheets/sheet2.xml")!.async("string");
  expect(afterXml.match(/<c r="C4"[^>]*\/>/)?.[0]).toEqual(beforeXml.match(/<c r="C4"[^>]*\/>/)?.[0]);
  expect(await afterZip.file("xl/worksheets/sheet1.xml")!.async("string")).toBe(await beforeZip.file("xl/worksheets/sheet1.xml")!.async("string"));
});

it("refuses layout areas that overlap populated cells or a different existing merge", async () => {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("current");
  sheet.getCell("A1").value = "description";
  sheet.getCell("B1").value = 100;
  expect(() => textFitArea(sheet, "A1:B1")).toThrow("덮어쓸");
  sheet.getCell("B1").value = null;
  sheet.mergeCells("A1:C1");
  expect(() => textFitArea(sheet, "A1:B1")).toThrow("병합 범위");
});
