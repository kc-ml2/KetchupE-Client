import ExcelJS from "exceljs";
import { createHash } from "node:crypto";
import type { AnalysisPlan, Report } from "./contracts.ts";

export const fixturePlan: AnalysisPlan = {
  kind: "execute", title: "일별 인장강도", format: "html", inputs: [{ fileId: "file1", sheet: "실험", headerRow: 1,
  columns: [{ index: 1, name: "실험일" }, { index: 2, name: "인장강도" }] }],
  steps: ["실험일별 평균과 측정 수 계산"], assumptions: ["단위 MPa, 한 행은 측정 한 건"],
  code: `const groups = new Map();
for (const r of input.rows) {
  const key = r.values["실험일"];
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}
return {tables:[{title:"일별 평균", columns:["실험일","평균 (MPa)","측정 수"], rows:[...groups].sort((a,b)=>a[0].localeCompare(b[0])).map(([day, rows])=>({cells:[day, rows.reduce((n,r)=>n+r.values["인장강도"],0)/rows.length,rows.length],sourceRows:rows.map(r=>r.id)}))}], excluded:[],notes:[],chart:{type:"bar",table:0,x:0,y:1,title:"일별 평균"}};`,
};

export async function fixtureWorkbook() {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("실험");
  sheet.addRow(["실험일", "인장강도", "메모"]);
  for (let i = 0; i < 60; i++) sheet.addRow([i < 30 ? "2026-10-19" : "2026-10-20", 40 + i, "관측"]);
  return new Uint8Array(await book.xlsx.writeBuffer());
}

export const fixtureReport: Report = {
  plan: fixturePlan, sources: [{ id: "file1", name: "실험.xlsx", fingerprint: "a".repeat(64) }], rowSources: { 2: { fileId: "file1", sheet: "실험", row: 2 }, 3: { fileId: "file1", sheet: "실험", row: 3 } }, summary: "날짜별 결과입니다.", createdAt: "2026-10-28T00:00:00.000Z", rowCount: 2, blankRows: 0,
  result: { tables: [{ title: "실험 결과", columns: ["실험일", "인장강도 (MPa)"], rows: [{ cells: ["2026-10-19", 50], sourceRows: [2] }, { cells: ["2026-10-20", 60], sourceRows: [3] }] }], excluded: [], notes: [], chart: { type: "bar", table: 0, x: 0, y: 1, title: "인장강도" } },
};

export async function comparisonFixture() {
  const before = new ExcelJS.Workbook(), after = new ExcelJS.Workbook();
  before.addWorksheet("실험").addRows([["소재", "인장강도"], ["A", { formula: "20+30", result: 50 }], ["B", 70]]);
  after.addWorksheet("실험").addRows([["소재명", "강도"], ["A", 60], ["B", 65]]);
  after.addWorksheet("기준").addRows([["소재명", "기준강도"], ["A", 55], ["B", 68]]);
  const files = await Promise.all([before, after].map(async (book, i) => {
    const bytes = new Uint8Array(await book.xlsx.writeBuffer());
    return { id: `file${i + 1}`, name: "실험.xlsx", fingerprint: createHash("sha256").update(bytes).digest("hex"), bytes };
  }));
  const plan: AnalysisPlan = {
    kind: "execute", title: "주차별 인장강도 비교", format: "html",
    inputs: [
      { fileId: "file1", sheet: "실험", headerRow: 1, columns: [{ index: 1, name: "소재" }, { index: 2, name: "인장강도" }] },
      { fileId: "file2", sheet: "실험", headerRow: 1, columns: [{ index: 1, name: "소재명" }, { index: 2, name: "강도" }] },
      { fileId: "file2", sheet: "기준", headerRow: 1, columns: [{ index: 1, name: "소재명" }, { index: 2, name: "기준강도" }] },
    ],
    steps: ["소재명으로 전주·금주 결과와 기준표 연결", "소재별 강도 변화 계산"],
    assumptions: ["file1은 전주, file2는 금주", "단위 MPa, 각 표에 소재당 한 행"],
    code: `const before = input.rows.filter(r => r.fileId === "file1");
const after = input.rows.filter(r => r.fileId === "file2" && r.sheet === "실험");
const targets = input.rows.filter(r => r.fileId === "file2" && r.sheet === "기준");
return {tables:[{title:"소재별 비교",columns:["소재","전주 (MPa)","금주 (MPa)","변화 (MPa)","기준 (MPa)"],rows:before.map(a => {
  const b = after.find(r => r.values["소재명"] === a.values["소재"]);
  const t = targets.find(r => r.values["소재명"] === a.values["소재"]);
  if (!b || !t) throw new Error("소재 연결 실패");
  return {cells:[a.values["소재"], a.values["인장강도"], b.values["강도"], b.values["강도"]-a.values["인장강도"], t.values["기준강도"]],sourceRows:[a.id,b.id,t.id]};
})}],excluded:[],notes:[],chart:{type:"bar",table:0,x:0,y:3,title:"소재별 강도 변화"}};`,
  };
  return { files, plan };
}
