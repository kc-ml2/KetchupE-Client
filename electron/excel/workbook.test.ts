// @vitest-environment node
import ExcelJS from "exceljs";
import { expect, it } from "vitest";
import { profileWorkbook, readAnalysisRows } from "./workbook.ts";
import { fixturePlan } from "./fixtures.ts";
import { runAnalysis } from "./sandbox.ts";
import { sheetPlan } from "./contracts.ts";

const bytesOf = async (book: ExcelJS.Workbook) => new Uint8Array(await book.xlsx.writeBuffer());

it("finds row labels below the first 20 rows, normalizes Korean spacing and includes nearby headers", async () => {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("실험");
  for (let row = 1; row < 60; row++) sheet.getCell(`A${row}`).value = "상단 안내";
  sheet.getRow(60).values = ["항목", "금액"];
  sheet.getRow(61).values = ["대 여 금".normalize("NFD"), 100];
  sheet.getRow(62).values = ["합계", 100];
  const bytes = await bytesOf(book);
  const profile = (await profileWorkbook(bytes, "대여금 행의 금액을 정리해줘")).sheets[0];
  expect(profile.search).toMatchObject({ matchedRowCount: 2, shownMatchRows: [60, 61], truncated: false });
  expect(profile.preview.find(row => row.row === 60)?.cells).toEqual(["항목", "금액"]);
  expect(profile.preview.find(row => row.row === 61)?.cells[1]).toBe(100);
  const plan = sheetPlan.parse({ ...fixturePlan.inputs[0], headerRow: 60, columns: [{ index: 1, name: "항목", key: "c1" }, { index: 2, name: "금액", key: "c2" }] });
  expect((await readAnalysisRows(bytes, plan)).rows.map(row => row.row)).toEqual([61, 62]);
});

it("discloses truncated matches and keeps unmatched searches distinct from full previews", async () => {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("실험");
  for (let row = 1; row <= 100; row++) sheet.getCell(`A${row}`).value = "원화";
  const bytes = await bytesOf(book);
  const found = (await profileWorkbook(bytes, "원화")).sheets[0];
  expect(found.search.matchedRowCount).toBe(100);
  expect(found.search.truncated).toBe(true);
  expect(found.preview.length).toBeLessThanOrEqual(80);
  const missing = (await profileWorkbook(bytes, "대여금")).sheets[0];
  expect(missing.search.matchedRowCount).toBe(0);
  expect(missing.preview).toHaveLength(20);
});

it.each(["H 243부터 봐줘", "H243", "$h$243"])("previews explicit cell coordinates and surrounding headers: %s", async query => {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("자금");
  sheet.getCell("H242").value = "항목"; sheet.getCell("I242").value = "금액";
  sheet.getCell("H243").value = "대여금"; sheet.getCell("I243").value = 100;
  sheet.getCell("H244").value = "합계"; sheet.getCell("I244").value = 100;
  const bytes = await bytesOf(book);
  const profile = (await profileWorkbook(bytes, query)).sheets[0];
  expect(profile.search).toMatchObject({ matchedRowCount: 0, requestedCells: [{ address: "H243", row: 243, column: 8, inBounds: true }], omittedCellCount: 0 });
  expect(profile.preview.find(row => row.row === 242)?.cells.slice(7)).toEqual(["항목", "금액"]);
  expect(profile.preview.find(row => row.row === 243)?.cells.slice(7)).toEqual(["대여금", 100]);
  expect(profile.preview.find(row => row.row === 244)?.cells.slice(7)).toEqual(["합계", 100]);
  const plan = sheetPlan.parse({ fileId: "file1", sheet: "자금", headerRow: 242, firstDataRow: 243, columns: [{ index: 8, name: "항목" }, { index: 9, name: "금액" }] });
  expect((await readAnalysisRows(bytes, plan)).rows[0]).toMatchObject({ row: 243, values: { 항목: "대여금", 금액: 100 } });
});

it("prioritizes coordinate anchors, bounds previews and reports omitted or out-of-bounds addresses", async () => {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("자금");
  for (let row = 1; row <= 500; row++) sheet.getCell(`H${row}`).value = "항목";
  const bytes = await bytesOf(book);
  const addresses = Array.from({ length: 12 }, (_, i) => `H${100 + i * 30}`);
  const profile = (await profileWorkbook(bytes, `항목 ${addresses.join(" ")}`)).sheets[0];
  expect(profile.preview.length).toBeLessThanOrEqual(80);
  expect(profile.search.omittedCellCount).toBe(2);
  for (const cell of profile.search.requestedCells) expect(profile.preview.some(row => row.row === cell.row)).toBe(true);
  expect(profile.search.truncated).toBe(true);
  const outside = (await profileWorkbook(bytes, "H999 Z243 file1 abcH243 H243abc H0")).sheets[0];
  expect(outside.search.requestedCells).toEqual([
    { address: "H999", row: 999, column: 8, inBounds: false },
    { address: "Z243", row: 243, column: 26, inBounds: false },
  ]);
  expect(outside.preview).toHaveLength(20);
});

it("indexes labels beyond the preview and lets the planner page through a selected sheet", async () => {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("자금");
  book.addWorksheet("다른 시트").addRow(["무관한 내용"]);
  for (let row = 1; row < 200; row++) sheet.getCell(`A${row}`).value = "반복 안내";
  for (let row = 200; row <= 265; row++) sheet.getCell(`H${row}`).value = `자금 항목 ${row}`;
  const bytes = await bytesOf(book);
  const initial = (await profileWorkbook(bytes)).sheets[0];
  expect(initial.preview).toHaveLength(20);
  expect(initial.outline.entries).toHaveLength(60);
  expect(initial.outline.entries[1]).toEqual({ row: 200, text: "H200: 자금 항목 200" });
  expect(initial.outline.nextRow).toBe(259);
  const page = await profileWorkbook(bytes, "", { sheet: "자금", startRow: initial.outline.nextRow! });
  expect(page.sheets).toHaveLength(1);
  expect(page.sheets[0].outline.entries[0].row).toBe(259);
  expect(page.sheets[0].outline.nextRow).toBeNull();
  expect(page.sheets[0].preview.map(row => row.row)).toEqual([259, 260, 261, 262, 263, 264, 265]);
  expect((await profileWorkbook(bytes, "", { sheet: "자금", startRow: 200 })).sheets[0].preview).toHaveLength(40);
  await expect(profileWorkbook(bytes, "", { sheet: "없는 시트" })).rejects.toThrow("시트가 없습니다");
  await expect(profileWorkbook(bytes, "", { sheet: "자금", startRow: 999 })).rejects.toThrow("범위 밖");
  await expect(profileWorkbook(bytes, "", { sheet: "자금", startRow: 0 })).rejects.toThrow();
});

it("keeps repeated merged headers and unnamed columns separate using explicit keys", async () => {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("실험");
  sheet.addRows([["구분", "금액", null, null], ["입출금", 100, 30, "비고"]]);
  sheet.mergeCells("B1:C1");
  const bytes = await bytesOf(book);
  const plan = sheetPlan.parse({ ...fixturePlan.inputs[0], columns: [
    { index: 1, name: "구분", key: "c1" }, { index: 2, name: "금액", key: "c2" },
    { index: 3, name: "금액", key: "c3" }, { index: 4, name: "", key: "c4" },
  ] });
  const { rows } = await readAnalysisRows(bytes, plan);
  expect(rows[0].values).toEqual({ c1: "입출금", c2: 100, c3: 30, c4: "비고" });
  expect(rows[0].sourceCells).toEqual({ c1: "A2", c2: "B2", c3: "C2", c4: "D2" });
  const result = await runAnalysis('return {tables:[{title:"차액",columns:["차액"],rows:input.rows.map(r=>({cells:[r.values.c2-r.values.c3],sourceRows:[r.id]}))}],excluded:[],notes:[],chart:null};', rows);
  expect(result.tables[0].rows[0].cells).toEqual([70]);
  await expect(readAnalysisRows(bytes, { ...plan, columns: [{ index: 2, name: "잘못된 헤더", key: "c2" }] })).rejects.toThrow("헤더가 일치하지");
});

it("distinguishes duplicate column indices from colliding analysis keys and guides code repair", async () => {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("실험");
  sheet.addRows([["금액", "금액", null], [100, 30, 1]]);
  const bytes = await bytesOf(book), plan = fixturePlan.inputs[0];
  await expect(readAnalysisRows(bytes, { ...plan, columns: [{ index: 1, name: "금액" }, { index: 2, name: "금액" }] })).rejects.toThrow('1열과 2열의 분석 식별자 "금액"');
  await expect(readAnalysisRows(bytes, { ...plan, columns: [{ index: 1, name: "금액", key: "c1" }, { index: 1, name: "금액", key: "c2" }] })).rejects.toThrow("1열을 중복 선택");
  await expect(readAnalysisRows(bytes, { ...plan, columns: [{ index: 1, name: "금액", key: "c1" }, { index: 2, name: "금액", key: "c1" }] })).rejects.toThrow('분석 식별자 "c1"');
  await expect(readAnalysisRows(bytes, { ...plan, columns: [{ index: 3, name: "" }] })).rejects.toThrow("헤더가 비어");
});

it("reads merged multi-row headers, repeated leaf labels, shared formulas and a cached zero", async () => {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("실험");
  sheet.mergeCells("A1:C1"); sheet.getCell("A1").value = "주간 실험 보고서";
  sheet.mergeCells("A2:A3"); sheet.getCell("A2").value = "실험일";
  sheet.getCell("B2").value = "인장강도"; sheet.getCell("C2").value = "신율";
  sheet.getCell("B3").value = "평균"; sheet.getCell("C3").value = "평균";
  sheet.mergeCells("A4:A5"); sheet.getCell("A4").value = "2026-10-19";
  sheet.getCell("A6").value = "2026-10-20";
  sheet.getCell("B4").value = { formula: "20+30", result: 50 };
  sheet.getCell("B5").value = { sharedFormula: "B4", result: 60 };
  sheet.getCell("B6").value = { formula: "1-1", result: 0 };
  for (let n = 4; n <= 6; n++) sheet.getCell(`C${n}`).value = 10;
  const bytes = await bytesOf(book);
  const profile = (await profileWorkbook(bytes)).sheets[0];
  expect(profile.preview[0].cells).toEqual(["주간 실험 보고서", "주간 실험 보고서", "주간 실험 보고서"]);
  expect(profile.preview[4].cells).toEqual(["2026-10-19", 60, 10]);
  expect(profile.mergedCells.A5).toBe("A4");
  expect(profile.formulaCells).toEqual(["B4", "B5", "B6"]);
  expect(profile.issues).toEqual([]);
  const plan = { ...fixturePlan.inputs[0], headerStartRow: 2, headerRow: 3, columns: [{ index: 1, name: "실험일" }, { index: 2, name: "인장강도 / 평균" }, { index: 3, name: "신율 / 평균" }] };
  const { rows, sourceNotes } = await readAnalysisRows(bytes, plan);
  expect(rows.map((r) => r.values["인장강도 / 평균"])).toEqual([50, 60, 0]);
  expect(rows.map((r) => r.sourceCells!["실험일"])).toEqual(["A4", "A4", "A6"]);
  expect(rows.map((r) => r.sourceCells!["인장강도 / 평균"])).toEqual(["B4", "B5", "B6"]);
  expect(sourceNotes.join(" ")).toContain("재계산하지 않았으므로");
  const result = await runAnalysis(fixturePlan.code.replaceAll('["인장강도"]', '["인장강도 / 평균"]'), rows);
  expect(result.tables[0].rows.map((r) => r.cells)).toEqual([["2026-10-19", 55, 2], ["2026-10-20", 0, 1]]);
});

it("does not conceal a cache-less formula or turn an Excel error into zero", async () => {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("실험");
  sheet.addRows([["실험일", "인장강도", "오류 열"], ["2026-10-19", { formula: "1+1" }, { formula: "1/0", result: { error: "#DIV/0!" } }]]);
  const bytes = await bytesOf(book);
  const profile = (await profileWorkbook(bytes)).sheets[0];
  expect(profile.issues).toEqual([
    { address: "B2", message: expect.stringContaining("저장된 계산 결과가 없습니다") },
    { address: "C2", message: expect.stringContaining("#DIV/0!") },
  ]);
  await expect(readAnalysisRows(bytes, fixturePlan.inputs[0])).rejects.toThrow("실험!B2");
  // Unrelated bad cells do not prevent reading a usable column.
  expect((await readAnalysisRows(bytes, { ...fixturePlan.inputs[0], columns: [{ index: 1, name: "실험일" }] })).rows[0].values).toEqual({ 실험일: "2026-10-19" });
});

it("distinguishes an explicit cached empty string from an absent formula result", async () => {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("실험");
  sheet.addRows([["실험일", "인장강도"], ["2026-10-19", { formula: 'IF(1=1,"",1)', result: "" }]]);
  const bytes = await bytesOf(book);
  expect((await profileWorkbook(bytes)).sheets[0].issues).toEqual([]);
  expect((await readAnalysisRows(bytes, fixturePlan.inputs[0])).rows[0].values["인장강도"]).toBe("");
});

it("keeps explicit inspection rows bounded even when query matches and cell hints are outside", async () => {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("자금");
  for (let row = 1; row <= 80; row++) sheet.getCell(`A${row}`).value = "USD 합계";
  const profile = await profileWorkbook(await bytesOf(book), "USD 합계 A75", { sheet: "자금", startRow: 19, endRow: 50, startColumn: 1, endColumn: 1 });
  expect(profile.sheets[0].preview.map(row => row.row)).toEqual(Array.from({ length: 32 }, (_, i) => i + 19));
  expect(profile.sheets[0].search.matchedRowCount).toBe(80);
  expect(profile.sheets[0].search.truncated).toBe(true);
  expect(Object.keys(profile.sheets[0].metadata)).toHaveLength(32);
  expect(profile.sheets[0].metadata).not.toHaveProperty("A75");
});

it("reads hyperlink labels, formatted dates and text/boolean formula results without visiting links", async () => {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("실험");
  sheet.addRows([["날짜", "링크", "텍스트", "참거짓"], [{ formula: "DATE(2026,10,19)", result: new Date("2026-10-19T00:00:00Z") }, { text: "실험 A", hyperlink: "https://example.invalid" }, { formula: '"결과"', result: "결과" }, { formula: "1=2", result: false }]]);
  sheet.getCell("A2").numFmt = "yyyy-mm-dd";
  const data = await readAnalysisRows(await bytesOf(book), { ...fixturePlan.inputs[0], columns: ["날짜", "링크", "텍스트", "참거짓"].map((name, i) => ({ index: i + 1, name })) });
  expect(data.rows[0].values).toEqual({ 날짜: "2026-10-19", 링크: "실험 A", 텍스트: "결과", 참거짓: "false" });
});

it("preserves numeric merged cell identity and checks explicit header/data bounds", async () => {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("실험");
  sheet.addRows([["실험일", "인장강도"], ["측정 안내", null], ["2026-10-19", 50], ["2026-10-20", null]]);
  sheet.mergeCells("B3:B4");
  const bytes = await bytesOf(book);
  const data = await readAnalysisRows(bytes, { ...fixturePlan.inputs[0], firstDataRow: 3 });
  expect(data.rows.map((r) => r.row)).toEqual([3, 4]);
  expect(data.rows.map((r) => r.sourceCells!["인장강도"])).toEqual(["B3", "B3"]);
  await expect(readAnalysisRows(bytes, { ...fixturePlan.inputs[0], headerStartRow: 2 })).rejects.toThrow("순서");
  await expect(readAnalysisRows(bytes, { ...fixturePlan.inputs[0], firstDataRow: 1 })).rejects.toThrow("순서");
});
