// @vitest-environment node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import ExcelJS from "exceljs";
import { PDFiumLibrary } from "@hyzyla/pdfium";
import { expect, it } from "vitest";
import { exportWithExcel } from "./nativeExcel.ts";
import { SelectiveWorkbook } from "../../work/selectiveWorkbook.ts";

// Opt in only on a machine with activated Excel; test-owned workbooks are closed by the native exporter.
async function excelSettings() {
  if (process.platform !== "darwin") return undefined;
  return (await promisify(execFile)("/usr/bin/osascript", ["-e", 'tell application id "com.microsoft.Excel" to return {display alerts, automation security, enable events, calculation, calculate before save}'])).stdout;
}
async function temporaryDirectory() {
  const root = process.platform === "darwin" ? join(homedir(), "Library/Containers/com.microsoft.Excel/Data/Library/Caches/KetchupE") : tmpdir();
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, "excel-integration-"));
}
it.skipIf(process.env.KETCHUPE_TEST_EXCEL !== "1")("calculates and prints only the selected sheet with the final cached values", async () => {
  const directory = await temporaryDirectory();
  try {
    const input = join(directory, `${basename(directory)}.xlsx`), pdf = join(directory, "report.pdf");
    const book = new ExcelJS.Workbook();
    const history = book.addWorksheet("history");
    history.getCell("A1").value = "HISTORY_MUST_NOT_PRINT";
    history.getCell("B1").value = { formula: "3+4", result: 7 };
    const sheet = book.addWorksheet("report");
    sheet.getColumn(1).width = 40;
    sheet.pageSetup.printArea = "A1:A6";
    sheet.getCell("A1").value = "TARGET_ONLY";
    sheet.getCell("A1").note = "Comment must stay in XLSX without covering the PNG.";
    sheet.getCell("A2").value = { formula: "history!B1+2", result: 0 };
    sheet.getCell("A3").value = { formula: "RAND()", result: 0.123456 };
    sheet.getCell("A4").value = { formula: "1=1", result: true } as unknown as ExcelJS.CellValue;
    sheet.getCell("A5").value = { formula: '"cached text"', result: "cached text" };
    sheet.getCell("A6").value = "OUTSIDE_SENTINEL";
    sheet.pageSetup.printArea = "A1:A5";
    await writeFile(input, Buffer.from(await book.xlsx.writeBuffer()));
    const signal = new AbortController().signal;
    const settings = await excelSettings();
    await exportWithExcel(input, sheet.name, pdf, signal, "calculate");
    const calculated = new ExcelJS.Workbook();
    await calculated.xlsx.load(await readFile(input) as unknown as ExcelJS.Buffer);
    expect(calculated.getWorksheet(sheet.name)!.getCell("A2").result).toBe(9);
    sheet.getCell("A2").value = { formula: "history!B1+2", result: 9 };
    const final = Buffer.from(await book.xlsx.writeBuffer());
    await writeFile(input, final);
    await exportWithExcel(input, sheet.name, pdf, signal, "pdf");
    expect(await readFile(input)).toEqual(final);
    expect(await excelSettings()).toEqual(settings);
    await expect(exportWithExcel(input, "missing-sheet", pdf, signal, "calculate")).rejects.toThrow();
    expect(await excelSettings()).toEqual(settings);
    const library = await PDFiumLibrary.init();
    try {
      const document = await library.loadDocument(await readFile(pdf));
      try {
        const text = [...document.pages()].map(page => page.getText()).join("\n");
        expect(document.getPageCount()).toBe(1);
        for (const value of ["TARGET_ONLY", "0.123456", "cached text"]) expect(text).toContain(value);
        expect(text).toMatch(/TRUE|참/);
        for (const value of ["HISTORY_MUST_NOT_PRINT", "OUTSIDE_SENTINEL"]) expect(text).not.toContain(value);
        const image = await document.getPage(0).render({ scale: 1, render: async ({ data }) => data });
        let yellow = 0;
        for (let i = 0; i < image.data.length; i += 4) if (image.data[i] > 240 && image.data[i + 1] > 240 && image.data[i + 2] < 20) yellow++;
        expect(yellow).toBe(0);
      } finally { document.destroy(); }
    } finally { library.destroy(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 120000);

it.skipIf(process.env.KETCHUPE_TEST_EXCEL !== "1")("fits overflowing descriptions to the whole display area without shrinking fonts or touching short rows", async () => {
  const directory = await temporaryDirectory();
  try {
    const input = join(directory, `${basename(directory)}.xlsx`), pdf = join(directory, "report.pdf");
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("report");
    sheet.getColumn(1).width = 12; sheet.getColumn(2).width = 12; sheet.getColumn(3).width = 15;
    for (let r = 1; r <= 4; r++) { sheet.getRow(r).height = 20; sheet.getCell(r, 1).font = { name: "Arial", size: 12 }; }
    sheet.getCell("A1").value = "short";
    sheet.getCell("A2").value = "A long payment description with a company name, invoice details and a final END_MARKER";
    sheet.getCell("C2").value = 1234;
    sheet.mergeCells("A3:B3"); sheet.getCell("A3").value = "An already merged description that also needs several visible lines MERGED_END";
    sheet.getCell("A4").value = "wrapped"; sheet.getCell("A4").alignment = { wrapText: true }; sheet.getRow(4).height = 36;
    sheet.pageSetup.printArea = "A1:C4";
    const source = Buffer.from(await book.xlsx.writeBuffer());
    const ranges = ["A1:B1", "A2:B2", "A3:B3", "A4:B4"];
    await writeFile(input, source);
    const signal = new AbortController().signal;
    await exportWithExcel(input, sheet.name, pdf, signal, "calculate", ranges);
    const calculated = (await (await SelectiveWorkbook.open(await readFile(input))).loadSheet(sheet.name)).getWorksheet(sheet.name)!;
    const fitted = (await readFile(`${input}.fit`, "utf8")).split(/\s+/).filter(Boolean);
    expect(fitted).toEqual(["A2:B2", "A3:B3"]);
    const bytes = await (await SelectiveWorkbook.open(source)).withCalculatedValues(calculated, [], "Excel", fitted);
    const final = (await (await SelectiveWorkbook.open(bytes)).loadSheet(sheet.name)).getWorksheet(sheet.name)!;
    for (const row of [2, 3]) {
      expect(final.getRow(row).height).toBeGreaterThan(20);
      expect(final.getCell(row, 1).font).toEqual(sheet.getCell(row, 1).font);
      expect(final.getCell(row, 1).alignment.wrapText).toBe(true);
      expect(final.getCell(row, 1).value).toBe(sheet.getCell(row, 1).value);
    }
    expect(final.getRow(1).height).toBe(20); expect(final.getRow(4).height).toBe(36);
    expect(final.model.merges.sort()).toEqual(["A2:B2", "A3:B3"]);
    expect(final.getCell("C2").value).toBe(1234);
    await writeFile(input, bytes);
    await exportWithExcel(input, sheet.name, pdf, signal, "pdf");
    expect(await readFile(input)).toEqual(Buffer.from(bytes));
    const library = await PDFiumLibrary.init();
    try {
      const document = await library.loadDocument(await readFile(pdf));
      try {
        const text = [...document.pages()].map(page => page.getText()).join(" ").replace(/\s+/g, " ");
        for (const value of ["END_MARKER", "MERGED_END", "1234"]) expect(text).toContain(value);
      } finally { document.destroy(); }
    } finally { library.destroy(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 120000);
