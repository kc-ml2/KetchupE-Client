// Build the app first, then bundle this script with esbuild (packages external) and run it with Electron.
// Uses fixture data and a separate temporary profile; never reads account credentials or calls a model.
import { app } from "electron";
import ExcelJS from "exceljs";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { comparisonFixture, fixturePlan, fixtureWorkbook } from "../electron/excel/fixtures.ts";
import { createExcelWorker } from "../electron/excel/workerClient.ts";
import type { ExcelJob } from "../electron/excel/workerClient.ts";
import { printReportPdf } from "../electron/excel/pdf.ts";
import { renderHtml } from "../electron/excel/render.ts";
import type { Report } from "../electron/excel/contracts.ts";

async function main() {
  const root = await mkdtemp(join(tmpdir(), "ketchupe-excel-smoke-"));
  app.setPath("userData", join(root, "profile"));
  app.on("window-all-closed", () => undefined);
  await app.whenReady();
  try {
    const { createExcelTool } = await import("../electron/excel/tool.ts");
    // One reused worker, as the app does per submission.
    const session = createExcelWorker(resolve("dist-electron/excel.worker.js"));
    const worker = "";
    const executeExcelJob = <J extends ExcelJob>(_path: string, job: J, jobSignal: AbortSignal) => session.run(job, jobSignal);
    const signal = AbortSignal.timeout(60000);
    const bytes = await fixtureWorkbook();
    const files = [{ id: "file1", name: "실험.xlsx", fingerprint: "a".repeat(64), bytes }];
    const profile = await executeExcelJob(worker, { kind: "profile", bytes }, signal);
    assert.equal(profile.sheets[0].rows, 61);
    const analysis = await executeExcelJob(worker, { kind: "analyze", files, plan: fixturePlan }, signal);
    assert.deepEqual(analysis.result.tables[0].rows.map((r) => r.cells), [["2026-10-19", 54.5, 30], ["2026-10-20", 84.5, 30]]);
    const report: Report = { ...analysis, plan: fixturePlan, sources: files.map(({ id, name, fingerprint }) => ({ id, name, fingerprint })), summary: "전체 60개 측정값으로 집계한 날짜별 인장강도입니다.", createdAt: new Date().toISOString() };
    for (const format of ["html", "xlsx"] as const) {
      const output = await executeExcelJob(worker, { kind: "export", report, format }, signal);
      assert.ok(output.length > 100);
      await writeFile(join(root, `report.${format}`), output);
    }
    const pdf = await printReportPdf(renderHtml(report), signal);
    assert.equal(Buffer.from(pdf.subarray(0, 5)).toString(), "%PDF-");
    await writeFile(join(root, "report.pdf"), pdf);
    const detailPlan = { ...fixturePlan, title: "실험 원자료", code: `return { tables: [{ title: "측정 결과", columns: ["실험일", "인장강도 (MPa)"], rows: input.rows.map(r => ({cells: [r.values["실험일"], r.values["인장강도"]], sourceRows: [r.id]})) }], excluded: [], notes: [], chart: null };`, steps: ["측정 원자료 정리"] };
    const detail = await executeExcelJob(worker, { kind: "analyze", files, plan: detailPlan }, signal);
    assert.equal(detail.result.tables[0].rows.length, 60);
    await writeFile(join(root, "detail.pdf"), await printReportPdf(renderHtml({ ...report, ...detail, plan: detailPlan, summary: "전체 60개 측정 원자료입니다." }), signal));
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("실험");
    sheet.mergeCells("A1:A2"); sheet.getCell("A1").value = "실험일";
    sheet.getCell("B1").value = "인장강도"; sheet.getCell("B2").value = "평균";
    sheet.mergeCells("A3:A4"); sheet.getCell("A3").value = "2026-10-19";
    sheet.getCell("A5").value = "2026-10-20";
    sheet.getCell("B3").value = { formula: "20+30", result: 50 };
    sheet.getCell("B4").value = { sharedFormula: "B3", result: 60 };
    sheet.getCell("B5").value = { formula: "1-1", result: 0 };
    sheet.getCell("C3").value = { formula: 'IF(TRUE,"",1)', result: "" };
    const complexBytes = new Uint8Array(await book.xlsx.writeBuffer());
    const complexPlan = { ...fixturePlan, inputs: [{ ...fixturePlan.inputs[0], headerStartRow: 1, headerRow: 2, columns: [{ index: 1, name: "실험일" }, { index: 2, name: "인장강도 / 평균" }] }], code: fixturePlan.code.replaceAll('["인장강도"]', '["인장강도 / 평균"]') };
    const complexProfile = await executeExcelJob(worker, { kind: "profile", bytes: complexBytes }, signal);
    assert.deepEqual(complexProfile.sheets[0].issues, []);
    assert.equal(complexProfile.sheets[0].preview[2].cells[2], "");
    const complex = await executeExcelJob(worker, { kind: "analyze", files: [{ ...files[0], bytes: complexBytes }], plan: complexPlan }, signal);
    assert.deepEqual(complex.result.tables[0].rows.map(r => r.cells), [["2026-10-19", 55, 2], ["2026-10-20", 0, 1]]);
    assert.match(complex.sourceNotes!.join(" "), /저장된 계산 결과/);
    const complexReport = { ...report, ...complex, plan: complexPlan, summary: "병합된 실험일과 저장된 수식 결과로 집계한 인장강도입니다." };
    for (const format of ["html", "xlsx"] as const) {
      await writeFile(join(root, `complex.${format}`), await executeExcelJob(worker, { kind: "export", report: complexReport, format }, signal));
    }
    await writeFile(join(root, "complex.pdf"), await printReportPdf(renderHtml(complexReport), signal));
    const comparison = await comparisonFixture();
    const compared = await executeExcelJob(worker, { kind: "analyze", files: comparison.files, plan: comparison.plan }, signal);
    assert.deepEqual(compared.result.tables[0].rows.map(r => r.cells), [["A", 50, 60, 10, 55], ["B", 70, 65, -5, 68]]);
    const comparisonReport: Report = { ...report, ...compared, plan: comparison.plan, sources: comparison.files.map(({ id, name, fingerprint }) => ({ id, name, fingerprint })), summary: "두 파일의 실험 결과와 기준 시트를 소재명으로 연결했습니다." };
    for (const format of ["html", "xlsx"] as const) {
      await writeFile(join(root, `comparison.${format}`), await executeExcelJob(worker, { kind: "export", report: comparisonReport, format }, signal));
    }
    await writeFile(join(root, "comparison.pdf"), await printReportPdf(renderHtml(comparisonReport), signal));
    const lookup = new ExcelJS.Workbook(), lookupSheet = lookup.addWorksheet("자금");
    lookupSheet.getCell("H242").value = "항목"; lookupSheet.getCell("I242").value = "금액";
    lookupSheet.getCell("H243").value = "대여금"; lookupSheet.getCell("I243").value = 100;
    lookupSheet.getCell("H244").value = "합계"; lookupSheet.getCell("I244").value = 100;
    const lookupBytes = new Uint8Array(await lookup.xlsx.writeBuffer());
    const overview = await executeExcelJob(worker, { kind: "profile", bytes: lookupBytes, query: "빌려준 돈을 정리해줘" }, signal);
    assert.ok(overview.sheets[0].outline.entries.some(entry => entry.row === 243 && entry.text.includes("대여금")));
    const searched = await executeExcelJob(worker, { kind: "profile", bytes: lookupBytes, query: "대여금", inspection: { sheet: "자금" } }, signal);
    assert.deepEqual(searched.sheets[0].search.shownMatchRows, [243]);
    const located = await executeExcelJob(worker, { kind: "profile", bytes: lookupBytes, query: "", inspection: { sheet: "자금", startRow: searched.sheets[0].search.shownMatchRows[0] - 5 } }, signal);
    assert.deepEqual(located.sheets[0].preview.find(row => row.row === 242)?.cells.slice(7), ["항목", "금액"]);
    const lookupPlan = { ...fixturePlan, inputs: [{ fileId: "file1", sheet: "자금", headerRow: 242, firstDataRow: 243, columns: [{ index: 8, name: "항목", key: "c1" }, { index: 9, name: "금액", key: "c2" }] }],
      code: 'return {tables:[{title:"대여금",columns:["금액"],rows:input.rows.filter(r=>r.values.c1==="대여금").map(r=>({cells:[r.values.c2],sourceRows:[r.id]}))}],excluded:input.rows.filter(r=>r.values.c1!=="대여금").map(r=>({row:r.id,reason:"합계 제외"})),notes:[],chart:null};' };
    const locatedResult = await executeExcelJob(worker, { kind: "analyze", files: [{ ...files[0], bytes: lookupBytes }], plan: lookupPlan }, signal);
    assert.deepEqual(locatedResult.result.tables[0].rows[0].cells, [100]);
    assert.equal(locatedResult.rowSources[locatedResult.result.tables[0].rows[0].sourceRows[0]].row, 243);
    const expandedBook = new ExcelJS.Workbook(), expandedSheet = expandedBook.addWorksheet("측정");
    expandedSheet.getRow(100).values = ["온도", "강도"];
    expandedSheet.getRow(101).values = [100, 50]; expandedSheet.getRow(102).values = [200, 80];
    expandedSheet.getCell("B103").value = { formula: "1+1" };
    const expandedBytes = new Uint8Array(await expandedBook.xlsx.writeBuffer());
    const expandedPlan = { ...fixturePlan, title: "범위 분석 대시보드", steps: ["선택한 측정 표의 온도와 강도 비교"], assumptions: ["온도와 강도는 원본 저장값, 한 행은 측정 한 건"], layout: "dashboard", formats: ["html", "xlsx", "pdf"],
      inputs: [{ fileId: "file1", sheet: "측정", rangeId: "measurements", headerRow: 100, firstDataRow: 101, lastDataRow: 102, columns: [{ index: 1, name: "온도", key: "x" }, { index: 2, name: "강도", key: "y" }] }],
      code: 'return {tables:[{title:"측정 결과",columns:["온도","강도"],rows:input.rows.map(r=>({cells:[r.values.x,r.values.y],sourceRows:[r.id]}))}],excluded:[],notes:[],chart:null,charts:[{type:"scatter",table:0,x:0,y:1,title:"온도와 강도",trendline:true},{type:"bar",table:0,x:0,y:1,title:"강도 비교"}]};' };
    const responses = [
      { kind: "inspect", fileId: "file1", sheet: "측정", query: "", startRow: 100, endRow: 102, startColumn: 1, endColumn: 2 },
      expandedPlan, { kind: "inspect_result", table: 0, startRow: 1, endRow: 2 },
      { kind: "finish", summary: "두 측정 결과를 확인했습니다.", sections: [{ title: "주간 실험 결과", text: "온도 100에서 강도 50, 온도 200에서 강도 80을 기록했습니다. 두 점으로 인과관계를 단정하지 않습니다." }] },
    ];
    const expandedTool = createExcelTool({
      complete: async () => JSON.stringify(responses.shift()),
      profile: (bytes, signal, query, inspection) => executeExcelJob(worker, { kind: "profile", bytes, query, inspection }, signal),
      analyze: (files, plan, signal) => executeExcelJob(worker, { kind: "analyze", files, plan }, signal),
      export: (report, format, signal) => executeExcelJob(worker, { kind: "export", report, format }, signal), pdf: printReportPdf,
    });
    const expanded = await expandedTool.execute({ files: { source: [{ bytes: Buffer.from(expandedBytes), name: "측정.xlsx", fingerprint: "b".repeat(64) }] }, values: { request: "측정 표만 분석해서 대시보드와 PDF, 엑셀로 만들어줘" }, checkpoint: {}, signal });
    assert.equal(expanded.status, "completed");
    if (expanded.status !== "completed") throw new Error("No expanded output");
    for (const file of [expanded.file, ...(expanded.additionalFiles ?? [])]) {
      if (!file.name.endsWith("xlsx")) await expandedTool.validateOutput!(file, signal);
      await writeFile(join(root, `expanded.${file.name.split(".").pop()}`), file.bytes);
    }
    assert.equal(expanded.additionalFiles?.length, 2);
    console.log(`Excel worker + QuickJS + HTML/XLSX + Electron PDF: passed\nArtifacts: ${root}`);
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { app.quit(); }
}
void main().catch((error) => { console.error(error); app.exit(1); });
