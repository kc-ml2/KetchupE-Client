import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import sharp from "sharp";
import JSZip from "jszip";
import { PDFiumLibrary } from "@hyzyla/pdfium";
import { SelectiveWorkbook } from "../../work/selectiveWorkbook.ts";
import { ExcelExportError, exportWithExcel } from "./nativeExcel.ts";
import { exportWithLibreOffice } from "./libreOffice.ts";
import { textFitArea } from "../../work/textFit.ts";

export async function pdfImage(pdf: Uint8Array, signal: AbortSignal): Promise<Buffer> {
  const library = await PDFiumLibrary.init();
  try {
    const document = await library.loadDocument(pdf);
    try {
      const pages: { input: Buffer; top: number; left: number }[] = [];
      let width = 0, height = 0;
      if (!document.getPageCount() || document.getPageCount() > 30) throw new Error("일보 PDF 페이지 수를 확인하세요.");
      for (const page of document.pages()) {
        signal.throwIfAborted();
        const size = page.getOriginalSize();
        const w = Math.ceil(size.originalWidth * 2), h = Math.ceil(size.originalHeight * 2);
        if (Math.max(width, w) * (height + h) > 96000000) throw new Error("일보 이미지 크기를 확인하세요.");
        const image = await page.render({ scale: 2, render: async ({ data, width, height }) => sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer() });
        pages.push({ input: Buffer.from(image.data), top: height, left: 0 });
        width = Math.max(width, image.width); height += image.height;
      }
      return await sharp({ create: { width, height, channels: 4, background: "white" } }).composite(pages).png().toBuffer();
    } finally { document.destroy(); }
  } finally { library.destroy(); }
}

/** Native engines own calculation and layout; only validated caches replace the preserved XLSX. */
export async function renderSheet(bytes: Uint8Array, name: string, checks: string[], signal: AbortSignal, textFitRanges: string[] = []) {
  signal.throwIfAborted();
  const zip = await JSZip.loadAsync(bytes);
  if (Object.keys(zip.files).some((path) => /(?:vbaProject\.bin|xl\/(?:macrosheets|queryTables|embeddings)\/|xl\/connections\.xml)/i.test(path))) throw new Error("매크로·자동 외부 연결이 있는 통합문서는 자동 출력할 수 없습니다.");
  const archive = await SelectiveWorkbook.open(bytes);
  const expected = (await archive.loadSheet(name)).getWorksheet(name)!;
  for (const range of textFitRanges) textFitArea(expected, range);
  expected.eachRow((row) => row.eachCell((cell) => {
    if (cell.formula && /\[[^\]]+\][^!]*!/.test(cell.formula)) throw new Error(`${cell.address}: 외부 통합문서 참조를 확인하세요. 자동 출력 전에 내부 시트 참조로 연결해야 합니다.`);
  }));
  try {
    return { ...await renderWithEngine(bytes, name, checks, signal, "Excel", textFitRanges), fallbackReason: undefined };
  } catch (error) {
    signal.throwIfAborted();
    if (!(error instanceof ExcelExportError)) throw error;
    try {
      return { ...await renderWithEngine(bytes, name, checks, signal, "LibreOffice", textFitRanges), fallbackReason: error.message };
    } catch (fallbackError) {
      signal.throwIfAborted();
      throw new Error(`${error.message}\nLibreOffice 대체 출력도 완료하지 못했습니다. ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
    }
  }
}

async function renderWithEngine(bytes: Uint8Array, name: string, checks: string[], signal: AbortSignal, engine: "Excel" | "LibreOffice", textFitRanges: string[]) {
  signal.throwIfAborted();
  // Each attempt starts from the pristine prepared workbook, even if Excel failed after saving.
  const archive = await SelectiveWorkbook.open(bytes);
  const exportFile = engine === "Excel" ? exportWithExcel : exportWithLibreOffice;
  // Excel for Mac cannot open arbitrary temporary paths without a per-file sandbox permission dialog.
  const temporaryRoot = engine === "Excel" && process.platform === "darwin" ? join(homedir(), "Library", "Containers", "com.microsoft.Excel", "Data", "Library", "Caches", "KetchupE") : tmpdir();
  let directory: string;
  try {
    await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
    directory = await mkdtemp(join(temporaryRoot, "ketchupe-report-"));
  } catch (error) {
    if (engine === "Excel") throw new ExcelExportError(`Excel 임시 작업 폴더를 만들지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  try {
    const input = join(directory, `${basename(directory)}.xlsx`), pdf = join(directory, `${basename(directory)}.pdf`);
    await writeFile(input, bytes, { mode: 0o600 });
    await exportFile(input, name, pdf, signal, "calculate", textFitRanges);
    const fitted = textFitRanges.length ? (await readFile(`${input}.fit`, "utf8")).split(/\s+/).filter(Boolean) : [];
    if (fitted.some(range => !textFitRanges.includes(range))) throw new Error("출력 엔진이 요청하지 않은 셀의 배치를 변경했습니다.");
    const calculated = (await (await SelectiveWorkbook.open(await readFile(input))).loadSheet(name)).getWorksheet(name)!;
    const output = await archive.withCalculatedValues(calculated, checks, engine, fitted);
    // Render the exact deliverable with calculation disabled; volatile formulas must not diverge from its caches.
    await writeFile(input, output);
    await exportFile(input, name, pdf, signal, "pdf");
    if (!(await readFile(input)).equals(Buffer.from(output))) throw new Error("PDF 출력 중 최종 XLSX가 변경되었습니다.");
    const image = await pdfImage(await readFile(pdf), signal);
    signal.throwIfAborted();
    return { bytes: output, image, sheet: calculated, engine };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
