// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { PDFiumLibrary } from "@hyzyla/pdfium";
import { expect, it } from "vitest";
import { exportWithLibreOffice } from "./libreOffice.ts";
import { SelectiveWorkbook } from "../../work/selectiveWorkbook.ts";
import { fixtureBooks } from "./fixtures.ts";
import { bindAccounts, buildReport, priorAmounts } from "./report.ts";
import { readCashStatus } from "./cashStatus.ts";
import { readWeekly } from "./weekly.ts";

// Opt in on machines with a full LibreOffice installation; ordinary CI does not launch desktop apps.
it.skipIf(process.env.KETCHUPE_TEST_LIBREOFFICE !== "1")("recalculates preserved cash SUMs and KRW totals after an execution amount changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lo-cash-formulas-"));
  try {
    const { report, status, weekly } = fixtureBooks(); const prior = report.getWorksheet(1)!;
    prior.getCell("E10").value = { formula: "SUM(D131:D136)", result: 0 };
    prior.getCell("G10").value = { formula: "SUM(D157:D174)", result: 0 };
    prior.getCell("H21").value = 2; prior.getCell("H28").value = -2;
    prior.getCell("L21").value = { formula: "TRUNC(H21*K21,0)", result: 0 };
    const amounts = priorAmounts(prior, {}).values, kc = readCashStatus(status);
    const { bindings } = bindAccounts(prior, kc.accounts, amounts, {}, "2026-10-13");
    const movements = readWeekly(weekly, "fixture").movements;
    const rates = { date: "2026-10-13", requestedDate: "2026-10-13", round: "1", publishedAt: "fixture", source: "fixture", fetchedAt: "fixture", responseHash: "fixture", perUnit: { USD: "1400.25", JPY: "9.5012", CNY: "200.1" } };
    const built = buildReport(report, prior, "2026-10-13", "2026-10-14", amounts, kc.accounts, bindings, movements.filter((m) => m.date === "2026-10-13"), movements.filter((m) => m.date === "2026-10-14"), rates, {}, new Map());
    built.sheet.getCell("D131").value = 12000;
    const input = join(directory, "source.xlsx"); await writeFile(input, Buffer.from(await report.xlsx.writeBuffer()));
    await exportWithLibreOffice(input, built.sheet.name, join(directory, "report.pdf"), new AbortController().signal, "calculate");
    const calculated = (await (await SelectiveWorkbook.open(await readFile(input))).loadSheet(built.sheet.name)).getWorksheet(built.sheet.name)!;
    expect(calculated.getCell("E10").result).toBe(12000);
    for (const address of ["H10", "H17", "D237", "G242", "G248"]) expect(calculated.getCell(address).result, address).toBe(111000);
    expect(calculated.getCell("E10").formula).toBe("SUM(D131)");
    expect(calculated.getCell("G248").formula).toBe("G242+G244+G246");
    expect(calculated.getCell("K23").value).toBe(9.5012);
    expect(calculated.getCell("L21").formula).toBe("ROUND(H21*K21,0)");
    expect(calculated.getCell("L21").result).toBe(2801);
    expect(calculated.getCell("L28").result).toBe(-2801);
    expect(calculated.getCell("B131").alignment.wrapText).not.toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 120000);

it.skipIf(process.env.KETCHUPE_TEST_LIBREOFFICE !== "1")("calculates and prints only the selected sheet with the final cached values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lo-integration-"));
  try {
    const input = join(directory, "source.xlsx"), pdf = join(directory, "report.pdf");
    const book = new ExcelJS.Workbook();
    const history = book.addWorksheet("history");
    history.getCell("A1").value = "HISTORY_MUST_NOT_PRINT";
    history.getCell("B1").value = { formula: "MISSING_LEGACY_FN()", result: 7 };
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
    await exportWithLibreOffice(input, sheet.name, pdf, signal, "calculate");
    const calculated = new ExcelJS.Workbook();
    await calculated.xlsx.load(await readFile(input) as unknown as ExcelJS.Buffer);
    expect(calculated.getWorksheet(sheet.name)!.getCell("A2").result).toBe(9);
    sheet.getCell("A2").value = { formula: "history!B1+2", result: 9 };
    const final = Buffer.from(await book.xlsx.writeBuffer());
    await writeFile(input, final);
    await exportWithLibreOffice(input, sheet.name, pdf, signal, "pdf");
    expect(await readFile(input)).toEqual(final);
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

it.skipIf(process.env.KETCHUPE_TEST_LIBREOFFICE !== "1")("fits overflowing descriptions to the whole display area without shrinking fonts or touching short rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lo-fit-"));
  try {
    const input = join(directory, "source.xlsx"), pdf = join(directory, "report.pdf");
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
    await exportWithLibreOffice(input, sheet.name, pdf, signal, "calculate", ranges);
    const calculated = (await (await SelectiveWorkbook.open(await readFile(input))).loadSheet(sheet.name)).getWorksheet(sheet.name)!;
    const fitted = (await readFile(`${input}.fit`, "utf8")).split(/\s+/).filter(Boolean);
    expect(fitted).toEqual(["A2:B2", "A3:B3"]);
    const bytes = await (await SelectiveWorkbook.open(source)).withCalculatedValues(calculated, [], "LibreOffice", fitted);
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
    await exportWithLibreOffice(input, sheet.name, pdf, signal, "pdf");
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
