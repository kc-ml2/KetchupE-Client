// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import sharp from "sharp";
import { SelectiveWorkbook } from "../../work/selectiveWorkbook.ts";
import { pdfImage, renderSheet } from "./image.ts";
import { ExcelExportError, exportWithExcel } from "./nativeExcel.ts";
import { LibreOfficeExportError, exportWithLibreOffice } from "./libreOffice.ts";
vi.mock("./nativeExcel.ts", async (original) => ({ ...await original<typeof import("./nativeExcel.ts")>(), exportWithExcel: vi.fn() }));
vi.mock("./libreOffice.ts", async (original) => ({ ...await original<typeof import("./libreOffice.ts")>(), exportWithLibreOffice: vi.fn() }));
afterEach(() => vi.resetAllMocks());

// Two valid PDF pages with distinct sizes/colors catch both page omission and bad stacking.
function pdfFixture() {
  const contents = ["1 0 0 rg 0 0 100 100 re f", "0 0 1 rg 0 0 80 50 re f"];
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>"];
  for (let i = 0; i < 2; i++) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${i ? "80 50" : "100 100"}] /Resources << >> /Contents ${4 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${contents[i].length} >>\nstream\n${contents[i]}\nendstream`);
  }
  let pdf = "%PDF-1.4\n"; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const start = pdf.length;
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(pdf);
}

it("rasterizes every native PDF page without re-laying out its contents", async () => {
  const image = await pdfImage(pdfFixture(), new AbortController().signal);
  expect(await sharp(image).metadata()).toMatchObject({ width: 200, height: 300, format: "png" });
  for (const [top, color] of [[20, [255, 0, 0, 255]], [220, [0, 0, 255, 255]]] as const) {
    expect([...await sharp(image).extract({ left: 20, top, width: 1, height: 1 }).raw().toBuffer()]).toEqual(color);
  }
});

it("refuses active content and unresolved external references before launching Excel", async () => {
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet("report");
  sheet.getCell("A1").value = { formula: "'[1]Sheet1'!A1", result: 5 };
  const bytes = new Uint8Array(await book.xlsx.writeBuffer());
  await expect(renderSheet(bytes, "report", [], new AbortController().signal)).rejects.toThrow("외부 통합문서");
  const zip = await JSZip.loadAsync(bytes); zip.file("xl/vbaProject.bin", "not executable");
  await expect(renderSheet(await zip.generateAsync({ type: "uint8array" }), "report", [], new AbortController().signal)).rejects.toThrow("매크로");
  expect(exportWithExcel).not.toHaveBeenCalled();
  expect(exportWithLibreOffice).not.toHaveBeenCalled();
});

it("does not render after cancellation", async () => {
  const abort = new AbortController(); abort.abort(new Error("cancelled"));
  await expect(pdfImage(pdfFixture(), abort.signal)).rejects.toThrow("cancelled");
});

it.each(["success", "calculate", "pdf", "changed"])("renders the final XLSX and cleans up after %s", async (outcome) => {
  const book = new ExcelJS.Workbook();
  book.addWorksheet("history").getCell("A1").value = "original";
  book.addWorksheet("report").getCell("A1").value = { formula: "1+1" };
  let temporary = "";
  let renderedBytes: Buffer | undefined;
  const stages: string[] = [];
  vi.mocked(exportWithExcel).mockImplementation(async (input, name, pdf, _signal, operation) => {
    temporary = dirname(input);
    stages.push(operation);
    if (outcome === operation) throw new Error(`native ${operation} failure`);
    const calculated = new ExcelJS.Workbook();
    await calculated.xlsx.load(await readFile(input) as unknown as ExcelJS.Buffer);
    if (operation === "calculate") {
      calculated.getWorksheet(name)!.getCell("A1").value = { formula: "1+1", result: 2 };
      calculated.getWorksheet("history")!.getCell("A1").value = "native rewrite";
      await writeFile(input, Buffer.from(await calculated.xlsx.writeBuffer()));
    } else {
      renderedBytes = await readFile(input);
      expect(calculated.getWorksheet("history")!.getCell("A1").value).toBe("original");
      expect(calculated.getWorksheet(name)!.getCell("A1").result).toBe(2);
      if (outcome === "changed") await writeFile(input, "unexpected mutation");
      await writeFile(pdf, pdfFixture());
    }
  });
  const pending = renderSheet(new Uint8Array(await book.xlsx.writeBuffer()), "report", [], new AbortController().signal);
  if (outcome !== "success") await expect(pending).rejects.toThrow(outcome === "changed" ? "최종 XLSX가 변경" : `native ${outcome} failure`);
  else {
    const result = await pending;
    expect(result.engine).toBe("Excel");
    expect(Buffer.from(result.bytes)).toEqual(renderedBytes);
    const output = new ExcelJS.Workbook(); await output.xlsx.load(Buffer.from(result.bytes) as unknown as ExcelJS.Buffer);
    expect(output.getWorksheet("report")!.getCell("A1").value).toEqual({ formula: "1+1", result: 2 });
    expect(await sharp(result.image).metadata()).toMatchObject({ width: 200, height: 300 });
  }
  expect(stages).toEqual(outcome === "calculate" ? ["calculate"] : ["calculate", "pdf"]);
  expect(temporary).not.toBe("");
  await expect(access(temporary)).rejects.toThrow();
  expect(exportWithLibreOffice).not.toHaveBeenCalled();
});

it.each(["calculate", "pdf"])("restarts from pristine bytes in LibreOffice after Excel %s fails", async (failedStage) => {
  const book = new ExcelJS.Workbook();
  book.addWorksheet("report").getCell("A1").value = { formula: "1+1" };
  const bytes = new Uint8Array(await book.xlsx.writeBuffer());
  const directories = new Set<string>();
  let renderedBytes: Buffer | undefined;
  vi.mocked(exportWithExcel).mockImplementation(async (input, _name, _pdf, _signal, operation) => {
    directories.add(dirname(input));
    if (operation === failedStage) {
      await writeFile(input, "partial failed Excel save");
      throw new ExcelExportError("Excel view-only");
    }
    book.getWorksheet("report")!.getCell("A1").value = { formula: "1+1", result: 2 };
    await writeFile(input, Buffer.from(await book.xlsx.writeBuffer()));
  });
  vi.mocked(exportWithLibreOffice).mockImplementation(async (input, _name, pdf, _signal, operation) => {
    directories.add(dirname(input));
    if (operation === "calculate") {
      expect(await readFile(input)).toEqual(Buffer.from(bytes));
      book.getWorksheet("report")!.getCell("A1").value = { formula: "1+1", result: 2 };
      await writeFile(input, Buffer.from(await book.xlsx.writeBuffer()));
    } else {
      renderedBytes = await readFile(input);
      await writeFile(pdf, pdfFixture());
    }
  });
  const result = await renderSheet(bytes, "report", [], new AbortController().signal);
  expect(result).toMatchObject({ engine: "LibreOffice", fallbackReason: "Excel view-only" });
  expect(Buffer.from(result.bytes)).toEqual(renderedBytes);
  expect(vi.mocked(exportWithLibreOffice).mock.calls.map(call => call[4])).toEqual(["calculate", "pdf"]);
  expect(directories.size).toBe(2);
  for (const directory of directories) await expect(access(directory)).rejects.toThrow();
});

it.each(["validation", "cancellation", "missing"])("handles %s without bypassing validation or cancellation", async (failure) => {
  const book = new ExcelJS.Workbook();
  book.addWorksheet("report").getCell("A1").value = { formula: "1+1" };
  const abort = new AbortController();
  vi.mocked(exportWithExcel).mockImplementation(async () => {
    if (failure === "cancellation") abort.abort(new Error("cancelled"));
    if (failure !== "validation") throw new ExcelExportError("Excel unavailable");
  });
  vi.mocked(exportWithLibreOffice).mockRejectedValue(new LibreOfficeExportError("LibreOffice를 설치하세요"));
  await expect(renderSheet(new Uint8Array(await book.xlsx.writeBuffer()), "report", [], abort.signal)).rejects.toThrow(
    failure === "validation" ? "수식 계산 결과" : failure === "cancellation" ? "cancelled" : /Excel unavailable[\s\S]*LibreOffice를 설치하세요/,
  );
  expect(exportWithLibreOffice).toHaveBeenCalledTimes(failure === "missing" ? 1 : 0);
});

it.each(["Excel", "LibreOffice"])("imports requested %s layout changes before printing the exact final XLSX", async (engine) => {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("report");
  sheet.getCell("B2").value = "long payment description";
  sheet.getCell("D2").value = 123;
  sheet.getRow(2).height = 15;
  if (engine === "LibreOffice") vi.mocked(exportWithExcel).mockRejectedValue(new ExcelExportError("view-only"));
  vi.mocked(engine === "Excel" ? exportWithExcel : exportWithLibreOffice).mockImplementation(async (input, name, pdf, _signal, operation, ranges) => {
    const loaded = (await (await SelectiveWorkbook.open(await readFile(input))).loadSheet(name)).getWorksheet(name)!;
    if (operation === "calculate") {
      expect(ranges).toEqual(["B2:C2"]);
      loaded.mergeCells("B2:C2"); loaded.getCell("B2").alignment = { wrapText: true }; loaded.getRow(2).height = 30;
      await writeFile(input, Buffer.from(await loaded.workbook.xlsx.writeBuffer()));
      await writeFile(`${input}.fit`, "B2:C2\n");
    } else {
      expect(loaded.getCell("B2").alignment.wrapText).toBe(true);
      expect(loaded.getRow(2).height).toBe(30);
      expect(loaded.getCell("D2").value).toBe(123);
      await writeFile(pdf, pdfFixture());
    }
  });
  const result = await renderSheet(new Uint8Array(await book.xlsx.writeBuffer()), "report", [], new AbortController().signal, ["B2:C2"]);
  expect(result.engine).toBe(engine);
  if (engine === "Excel") expect(exportWithLibreOffice).not.toHaveBeenCalled();
});
