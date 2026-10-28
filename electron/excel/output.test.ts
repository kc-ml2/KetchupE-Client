// @vitest-environment node
import { expect, it } from "vitest";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { JSDOM } from "jsdom";
import { DOMParser } from "@xmldom/xmldom";
import { fixtureReport } from "./fixtures.ts";
import { chartSvg, renderHtml, renderXlsx, reportPreview, validReportHtml } from "./render.ts";
import { validateResult } from "./contracts.ts";

it("omits internal analysis steps from HTML, PDF source, XLSX and chat preview while keeping criteria", async () => {
  const report = structuredClone(fixtureReport);
  report.plan.steps = ["INTERNAL_ONLY_먼저 셀을 탐색하고 계산 코드를 실행한다"];
  report.plan.assumptions = ["저장된 측정값의 산술평균"];
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await renderXlsx(report) as never);
  const cells: string[] = [];
  book.eachSheet(sheet => sheet.eachRow(row => row.eachCell(cell => cells.push(cell.text))));
  for (const text of [renderHtml(report), renderHtml(report, false), cells.join("\n"), reportPreview(report)]) {
    expect(text).not.toContain("분석 계획");
    expect(text).not.toContain("INTERNAL_ONLY");
    expect(text).toContain(report.summary);
  }
  expect(renderHtml(report)).toContain(report.plan.assumptions[0]);
  expect(cells).toContain(report.plan.assumptions[0]);
  expect(cells.some(value => value.includes("실험"))).toBe(true);
});

it("renders multiple charts, safe interactive filtering and static printable output", async () => {
  const report = structuredClone(fixtureReport);
  report.plan.layout = "dashboard";
  report.result.tables[0].columns[0] = "온도";
  report.result.tables[0].rows[0].cells[0] = 100;
  report.result.tables[0].rows[1].cells[0] = 200;
  report.result.chart = null;
  report.result.charts = [
    { type: "scatter", table: 0, x: 0, y: 1, title: "온도와 강도", trendline: true },
    { type: "pie", table: 0, x: 0, y: 1, title: "비중" },
  ];
  report.sections = [{ title: "검토 결과", text: '<script>alert("bad")</script>' }];
  const html = renderHtml(report);
  expect(validReportHtml(html)).toBe(true);
  expect(validReportHtml(html.replace('document.querySelectorAll', 'alert'))).toBe(false);
  expect(renderHtml(report, false)).not.toContain("<script>");
  const dom = new JSDOM(html, { runScripts: "dangerously" });
  try {
    expect(dom.window.document.querySelectorAll("svg")).toHaveLength(2);
    const input = dom.window.document.querySelector("input")!;
    input.value = "200"; input.dispatchEvent(new dom.window.Event("input"));
    expect([...dom.window.document.querySelectorAll("tbody tr")].map(row => (row as { hidden?: boolean }).hidden)).toEqual([true, false]);
    expect(chartSvg(report)).toContain("stroke-dasharray");
  } finally { dom.window.close(); }
  const zip = await JSZip.loadAsync(await renderXlsx(report));
  for (const n of [1, 2]) {
    for (const path of [`xl/charts/chart${n}.xml`, `xl/drawings/drawing${n}.xml`, `xl/drawings/_rels/drawing${n}.xml.rels`, `xl/worksheets/_rels/sheet${n + 3}.xml.rels`]) {
      const source = await zip.file(path)!.async("string");
      new DOMParser({ onError: (_level, message) => { throw new Error(message); } }).parseFromString(source, "application/xml");
    }
  }
  expect(await zip.file("xl/charts/chart1.xml")!.async("string")).toContain('<c:trendlineType val="linear"/>');
  expect(await zip.file("xl/charts/chart2.xml")!.async("string")).toContain("<c:pieChart>");
  expect(await zip.file("xl/worksheets/sheet4.xml")!.async("string")).toContain('<drawing r:id="rId1"/>');
  expect(await zip.file("[Content_Types].xml")!.async("string")).toContain('/xl/charts/chart2.xml');
  const invalid = structuredClone(report.result);
  invalid.tables[0].rows[0].cells[0] = "문자";
  expect(() => validateResult(invalid, [2, 3].map(id => ({ id, fileId: "file1", sheet: "실험", row: id, values: {} })))).toThrow("x값");
});
