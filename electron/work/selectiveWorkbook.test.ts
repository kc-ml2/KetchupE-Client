// @vitest-environment node
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { expect, it, vi } from "vitest";
import { SelectiveWorkbook } from "./selectiveWorkbook.ts";
import { annualReportFixture } from "../business/dailyCash/fixtures.ts";

it("never inflates archived worksheet XML while loading or saving a 366-sheet workbook", async () => {
  const bytes = await annualReportFixture();
  const zip = await JSZip.loadAsync(bytes);
  const prototype = Object.getPrototypeOf(zip.file("xl/worksheets/sheet1.xml")!);
  const original = prototype.async;
  const read = vi.spyOn(prototype, "async").mockImplementation(function (this: JSZip.JSZipObject, ...args: unknown[]) {
    if (/^xl\/worksheets\/sheet\d+\.xml$/.test(this.name) && this.name !== "xl/worksheets/sheet1.xml" && this.name !== "xl/worksheets/sheet2.xml") throw new Error(`Historical sheet inflated: ${this.name}`);
    return original.apply(this, args);
  });
  let output: Uint8Array;
  try {
    const archive = await SelectiveWorkbook.open(bytes);
    expect(archive.sheetNames).toHaveLength(366);
    const book = await archive.loadSheet("261012"); expect(book.worksheets.map((s) => s.name)).toEqual(["261012"]);
    book.addWorksheet("261013").getCell("A1").value = "새 일보";
    output = await archive.appendSheet(book, "261013");
  } finally { read.mockRestore(); }
  const saved = await JSZip.loadAsync(output!);
  for (let id = 1; id <= 366; id++) {
    const path = `xl/worksheets/sheet${id}.xml`;
    expect(await saved.file(path)!.async("string")).toBe(await zip.file(path)!.async("string"));
  }
  expect((await SelectiveWorkbook.open(output!)).sheetNames).toHaveLength(367);
}, 30000);

it("preserves old formulas, shared strings, custom formats, names, hidden sheets and related parts across successive appends", async () => {
  const original = new ExcelJS.Workbook(); original.properties.date1904 = true;
  const old = original.addWorksheet("과거 & 자료", { state: "hidden" });
  old.getCell("A1").value = "원본 문자열"; old.getCell("B1").value = { formula: "1+2", result: 3 };
  old.getCell("B1").numFmt = '0.0000"원"'; old.getCell("B1").font = { color: { argb: "FF123456" }, bold: true };
  old.getCell("C1").value = { text: "원본 링크", hyperlink: "https://example.com/archive" }; old.getCell("A1").note = "원본 메모";
  old.addTable({ name: "ArchivedBalances", ref: "A5", columns: [{ name: "balance" }], rows: [[321]] });
  original.definedNames.add("'과거 & 자료'!$B$1", "HistoricalBalance");
  const template = original.addWorksheet("261012"); template.getCell("A1").value = "다른 문자열"; template.pageSetup.printArea = "A1:D8";
  template.getCell("B1").numFmt = '0.00"USD"'; template.getCell("B1").value = 12.5;
  const input = Buffer.from(await original.xlsx.writeBuffer()); const zip = await JSZip.loadAsync(input);
  zip.file("customXml/preserved.xml", '<custom value="must survive"/>');
  const before = await zip.generateAsync({ type: "uint8array" });
  let bytes = before;
  for (const name of ["261013", "261014"]) {
    const archive = await SelectiveWorkbook.open(bytes); const book = await archive.loadSheet("261012");
    const added = book.addWorksheet(name); added.pageSetup.printArea = "A1:D8";
    added.getCell("A1").value = { richText: [{ font: { bold: true }, text: `${name} 새 문자열` }] };
    added.getCell("B1").value = 123.45; added.getCell("B1").numFmt = '0.000"NEW"'; added.getCell("B1").font = { italic: true, color: { argb: "FFCC0000" } };
    added.getCell("C1").value = { formula: "'과거 & 자료'!B1+1", result: 4 };
    added.getCell("D1").value = { text: "새 링크", hyperlink: "https://example.com/new" }; added.getCell("D1").note = "새 메모";
    added.getCell("A2").value = new Date("2026-10-13T00:00:00Z");
    added.addConditionalFormatting({ ref: "B1", rules: [{ type: "cellIs", operator: "greaterThan", formulae: ["0"], priority: 1, style: { font: { bold: true, color: { argb: "FF00FF00" } } } }] });
    bytes = await archive.appendSheet(book, name);
  }
  const output = new ExcelJS.Workbook(); await output.xlsx.load(Buffer.from(bytes) as unknown as ExcelJS.Buffer);
  expect(output.worksheets.map((s) => s.name)).toEqual(["과거 & 자료", "261012", "261013", "261014"]);
  expect(output.getWorksheet("과거 & 자료")!.state).toBe("hidden");
  expect(output.getWorksheet("과거 & 자료")!.getCell("B1").value).toEqual({ formula: "1+2", result: 3 });
  expect(output.getWorksheet("과거 & 자료")!.getCell("B1").numFmt).toBe('0.0000"원"');
  expect(output.definedNames.getRanges("HistoricalBalance").ranges).toEqual(["'과거 & 자료'!$B$1"]);
  for (const name of ["261013", "261014"]) {
    const sheet = output.getWorksheet(name)!;
    expect(sheet.getCell("A1").text).toBe(`${name} 새 문자열`); expect(sheet.getCell("B1").numFmt).toBe('0.000"NEW"');
    expect(sheet.getCell("B1").font).toMatchObject({ italic: true, color: { argb: "FFCC0000" } });
    expect(sheet.getCell("C1").value).toEqual({ formula: "'과거 & 자료'!B1+1", result: 4 });
    expect(sheet.getCell("D1").hyperlink).toBe("https://example.com/new"); expect(sheet.getCell("D1").note).toBe("새 메모");
    expect(sheet.getCell("A2").value).toEqual(new Date("2026-10-13T00:00:00Z")); expect(sheet.pageSetup.printArea).toBe("A1:D8");
    expect((sheet.model as ExcelJS.WorksheetModel & { conditionalFormattings: ExcelJS.ConditionalFormattingOptions[] }).conditionalFormattings[0].rules[0].style?.font).toMatchObject({ bold: true, color: { argb: "FF00FF00" } });
  }
  const after = await JSZip.loadAsync(bytes);
  const changed = new Set(["xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "[Content_Types].xml"]);
  for (const [path, part] of Object.entries(zip.files)) if (!part.dir && !changed.has(path)) expect(await after.file(path)!.async("uint8array"), path).toEqual(await part.async("uint8array"));
});

it("rejects missing/duplicate sheets, malformed metadata and external worksheet targets", async () => {
  const book = new ExcelJS.Workbook(); book.addWorksheet("261012");
  const bytes = new Uint8Array(await book.xlsx.writeBuffer()); const archive = await SelectiveWorkbook.open(bytes);
  await expect(archive.loadSheet("없음")).rejects.toThrow("시트"); await expect(archive.appendSheet(book, "261012")).rejects.toThrow("이미");
  const zip = await JSZip.loadAsync(bytes);
  zip.file("xl/_rels/workbook.xml.rels", (await zip.file("xl/_rels/workbook.xml.rels")!.async("string")).replace('Target="worksheets/sheet1.xml"', 'TargetMode="External" Target="https://example.com/sheet.xml"'));
  await expect((await SelectiveWorkbook.open(await zip.generateAsync({ type: "uint8array" }))).loadSheet("261012")).rejects.toThrow("지원하지");
  zip.file("xl/workbook.xml", '<!DOCTYPE workbook SYSTEM "file:///tmp/secret"><workbook/>');
  await expect(SelectiveWorkbook.open(await zip.generateAsync({ type: "uint8array" }))).rejects.toThrow("DOCTYPE");
});


it("adds styles to an otherwise valid workbook that has no style part", async () => {
  const original = new ExcelJS.Workbook(); original.addWorksheet("261012").getCell("A1").value = "original";
  const zip = await JSZip.loadAsync(await original.xlsx.writeBuffer()); zip.remove("xl/styles.xml");
  for (const path of ["xl/_rels/workbook.xml.rels", "[Content_Types].xml"]) zip.file(path, (await zip.file(path)!.async("string")).replace(/<(?:Relationship|Override)\b[^>]*(?:Type="[^"]*\/styles"|PartName="\/xl\/styles.xml")[^>]*\/>/g, ""));
  const archive = await SelectiveWorkbook.open(await zip.generateAsync({ type: "uint8array" }));
  const selected = await archive.loadSheet("261012"); const added = selected.addWorksheet("261013");
  added.getCell("A1").value = 10; added.getCell("A1").numFmt = '0.00"원"'; added.pageSetup.printArea = "A1:B2";
  const result = await archive.appendSheet(selected, "261013"); const book = new ExcelJS.Workbook(); await book.xlsx.load(Buffer.from(result) as unknown as ExcelJS.Buffer);
  expect(book.getWorksheet("261012")!.getCell("A1").value).toBe("original");
  expect(book.getWorksheet("261013")!.getCell("A1").numFmt).toBe('0.00"원"'); expect(book.getWorksheet("261013")!.pageSetup.printArea).toBe("A1:B2");
  const output = await JSZip.loadAsync(result);
  expect(await output.file("xl/_rels/workbook.xml.rels")!.async("string")).toContain('Target="styles.xml"');
});

it("stops before producing a workbook with duplicated structured-table names", async () => {
  const original = new ExcelJS.Workbook(); original.addWorksheet("261012");
  const archive = await SelectiveWorkbook.open(new Uint8Array(await original.xlsx.writeBuffer()));
  original.addWorksheet("261013").addTable({ name: "Balances", ref: "A1", columns: [{ name: "balance" }], rows: [[100]] });
  await expect(archive.appendSheet(original, "261013")).rejects.toThrow("Excel 표");
});
