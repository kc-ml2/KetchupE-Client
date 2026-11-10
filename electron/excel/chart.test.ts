// @vitest-environment node
import { expect, it } from "vitest";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";
import { fixtureReport } from "./fixtures.ts";
import { chartOption, chartSvg } from "./chart.ts";
import { renderHtml, renderXlsx, validReportHtml } from "./render.ts";
import { validateResult, type ChartSpec, type InputRow, type Report } from "./contracts.ts";
import { mergeView, type ReportView } from "./view.ts";

type View = ReportView["charts"][string];
function report(columns: string[], rows: (string | number)[][], chart: Partial<ChartSpec>, view?: View): Report {
  const next = structuredClone(fixtureReport);
  next.result.tables = [{ title: "표", columns, rows: rows.map((cells, i) => ({ cells, sourceRows: [i + 1] })) }];
  next.result.chart = null;
  next.result.charts = [{ type: "bar", table: 0, x: 0, y: 1, title: "차트", ...chart }];
  next.rowSources = Object.fromEntries(rows.map((_, i) => [i + 1, { fileId: "file1", sheet: "실험", row: i + 2 }]));
  if (view) next.view = { charts: { "0": view } };
  return next;
}
const inputs = (value: Report): InputRow[] => value.result.tables[0].rows.map((_, i) => ({ id: i + 1, fileId: "file1", sheet: "실험", row: i + 2, values: {} }));
const option = (value: Report) => chartOption(value, value.result.charts![0]);
const sales = ["1월", "2월", "3월", "4월"].map((month, i) => [month, 100 + i * 10, 40 - i * 5, i + 1]);
const columns = ["월", "매출", "비용", "성장률"];

it("renders every chart type as static, script-free SVG that fits the report CSP", () => {
  const cases: Report[] = [
    report(columns, sales, { type: "bar", stack: true, series: [{ y: 1, axis: "left" }, { y: 2, axis: "left" }] }),
    report(columns, sales, { type: "bar", horizontal: true }),
    report(columns, sales, { type: "area", smooth: true, series: [{ y: 1, axis: "left" }, { y: 3, axis: "right" }] }),
    report(columns, sales, { type: "line" }),
    report(["x", "y"], [[1, 2], [2, 4], [3, 7]], { type: "scatter", trendline: true }),
    report(columns, sales, { type: "pie", donut: true }),
    report(["id", "값"], Array.from({ length: 50 }, (_, i) => [i, i % 9]), { type: "histogram", bins: 5 }),
    report(["그룹", "값"], Array.from({ length: 30 }, (_, i) => ["AB"[i % 2], i]), { type: "boxplot" }),
    report(["요일", "시간대", "건수"], [["월", "오전", 1], ["월", "오후", 2], ["화", "오전", 3]], { type: "heatmap", y: 1, value: 2 }),
  ];
  for (const value of cases) {
    expect(() => validateResult(value.result, inputs(value))).not.toThrow();
    const svg = chartSvg(value);
    expect(svg).toMatch(/^<svg role="img" aria-label="차트" width="960" height="\d+"[^>]* viewBox="0 0 960 \d+"/);
    expect(svg).not.toMatch(/<script|zr\d+-|href=|javascript:/i);
    new DOMParser({ onError: (_level, message) => { throw new Error(message); } }).parseFromString(svg, "image/svg+xml");
    expect(chartSvg(value)).toBe(svg); // reproducible across renders
    expect(validReportHtml(renderHtml(value))).toBe(true);
  }
});

it("keeps ids and styles of several charts in one report from colliding", () => {
  const value = report(columns, sales, { type: "line" });
  value.result.charts!.push({ type: "bar", table: 0, x: 0, y: 2, title: "둘째 <차트> & \"따옴표\"" });
  const [first, second] = value.result.charts!.map(chart => chartSvg(value, chart));
  expect(first).toContain("chart0-");
  expect(second).toContain("chart1-");
  expect(second).not.toContain("chart0-");
  expect(second).toContain('aria-label="둘째 &lt;차트&gt; &amp; &quot;따옴표&quot;"');
  expect(second).toContain("둘째 &lt;차트&gt; &amp;");
});

it("builds stacked, horizontal and dual-axis series from the chart spec", () => {
  const stacked = option(report(columns, sales, { type: "bar", stack: true, horizontal: true, series: [{ y: 1, axis: "left" }, { y: 2, axis: "left" }] })).option;
  expect(stacked.series.map(series => [series.type, series.stack, series.data[0]])).toEqual([["bar", "left", [100, 0]], ["bar", "left", [40, 0]]]);
  expect(stacked.xAxis).toMatchObject({ type: "value", scale: false });
  expect(stacked.yAxis).toMatchObject({ type: "category", data: ["1월", "2월", "3월", "4월"], inverse: true });
  const dual = option(report(columns, sales, { type: "area", series: [{ y: 1, axis: "left" }, { y: 3, axis: "right" }] })).option;
  expect(dual.series.map(series => [series.type, series.name, series.yAxisIndex, Boolean(series.areaStyle)])).toEqual([["line", "매출 (왼쪽 축)", 0, true], ["line", "성장률 (오른쪽 축)", 1, true]]);
  expect(dual.legend).toMatchObject({ data: ["매출 (왼쪽 축)", "성장률 (오른쪽 축)"] });
});

it("bins a histogram, summarizes box plots with outliers and places heatmap cells", () => {
  const histogram = option(report(["id", "값"], [0, 1, 2, 3, 4, 5, 6, 7, 8, 10].map((value, i) => [i, value]), { type: "histogram", bins: 5 }));
  expect(histogram.option.series[0].data).toEqual([2, 2, 2, 2, 2]);
  expect(histogram.option.xAxis).toMatchObject({ data: ["0–2", "2–4", "4–6", "6–8", "8–10"] });
  expect(histogram.notes[0]).toContain("구간 5개");
  const box = option(report(["그룹", "값"], [1, 2, 3, 4, 5, 100].map(value => ["A", value]), { type: "boxplot" })).option;
  expect(box.series[0].data).toEqual([[1, 2.25, 3.5, 4.75, 5]]);
  expect(box.series[1]).toMatchObject({ type: "scatter", data: [[0, 100]] });
  const heat = option(report(["요일", "시간대", "건수"], [["월", "오전", 1], ["화", "오후", 5], ["월", "오전", 3]], { type: "heatmap", y: 1, value: 2 }));
  expect(heat.option.series[0].data).toEqual([[0, 0, 3], [1, 1, 5]]);
  expect(heat.option.visualMap).toMatchObject({ min: 3, max: 5 });
  expect(heat.notes[0]).toContain("마지막 값");
});

it("applies log scale, min/mean annotations, value labels and colors as display edits", () => {
  const base = report(["x", "y"], [[1, 10], [2, 1000], [3, 100], [4, 10]], { type: "line", xScale: "linear" });
  base.view = mergeView(undefined, { charts: { "0": { colors: ["#111111"], labels: true, axes: { left: { scale: "log", tickValues: [1, 10, 100, 1000] } }, annotations: [{ series: 0, kind: "min" }, { series: 0, kind: "mean" }, { series: 0, kind: "max", label: "피크" }] } } });
  expect(base.view.charts["0"].annotations!.map(item => item.label)).toEqual(["최소점", "평균", "피크"]);
  const { option: drawn, notes } = option(base);
  expect([drawn.yAxis].flat()[0]).toMatchObject({ type: "log", min: 1, max: 1000, axisLabel: { customValues: [1, 10, 100, 1000] } });
  expect((drawn.color as string[]).slice(0, 2)).toEqual(["#111111", "#2563eb"]);
  expect(drawn.series[0]).toMatchObject({ label: { show: true }, markPoint: { data: [{ coord: [1, 10] }, { coord: [2, 1000] }] }, markLine: { data: [{ yAxis: 280 }] } });
  expect(notes).toEqual(["최소점: X=1, Y=10 · 동률 2점 중 첫 측정점", "평균: y = 280 (4점)", "피크: X=2, Y=1000"]);
  expect(chartSvg(base)).toContain("피크: X=2, Y=1000");
  // Clearing a display edit restores the default; replacing one annotation keeps the others.
  const cleared = mergeView(base.view, { charts: { "0": { colors: null, labels: null, annotations: [{ series: 0, kind: "min", label: "바닥" }] } } }).charts["0"];
  expect(cleared).not.toHaveProperty("colors");
  expect(cleared.annotations!.map(item => item.label)).toEqual(["바닥", "평균", "피크"]);
});

it("explains unsupported display edits instead of drawing a misleading chart", () => {
  const line = report(["x", "y"], [[1, 0], [2, 5]], { type: "line", xScale: "linear" }, { axes: { left: { scale: "log" } } });
  expect(() => renderHtml(line)).toThrow("0보다 큰 값");
  expect(() => renderHtml(report(columns, sales, { type: "bar" }, { axes: { x: { min: 0 } } }))).toThrow("숫자형 X축");
  expect(() => renderHtml(report(columns, sales, { type: "pie" }, { axes: { left: { min: 0 } } }))).toThrow("원형 차트와 히트맵");
  expect(() => renderHtml(report(columns, sales, { type: "pie" }, { annotations: [{ series: 0, kind: "max", label: "최대점", scope: "selectedData" }] }))).toThrow("선·영역·산점도·막대");
  expect(() => renderHtml(report(["x", "y"], [[1, 1], [2, 5]], { type: "line", xScale: "linear" }, { axes: { left: { scale: "log", tickStep: 2 } } }))).toThrow("tickValues");
  expect(() => renderHtml(report(["id", "값"], Array.from({ length: 501 }, (_, i) => [i, i]), { type: "scatter" }, { labels: true }))).toThrow("500점");
});

it("rejects chart options that do not match the chart type or its data", () => {
  const check = (chart: Partial<ChartSpec>, rows: (string | number)[][] = sales) => { const value = report(columns, rows, chart); return () => validateResult(value.result, inputs(value)); };
  expect(check({ type: "line", stack: true })).toThrow("stack은 막대·영역");
  expect(check({ type: "bar", donut: true })).toThrow("donut은 원형");
  expect(check({ type: "pie", series: [{ y: 1, axis: "left" }, { y: 2, axis: "left" }] })).toThrow("복수 시리즈");
  expect(check({ type: "bar", horizontal: true, series: [{ y: 1, axis: "left" }, { y: 2, axis: "right" }] })).toThrow("보조축");
  expect(check({ type: "bar", xScale: "linear", x: 1, y: 2 })).toThrow("xScale");
  expect(check({ type: "heatmap", y: 1 })).toThrow("value 열");
  expect(check({ type: "bar", value: 2 })).toThrow("value 열");
  expect(check({ type: "heatmap", y: 1, value: 0 })).toThrow("히트맵은");
  expect(check({ type: "boxplot", x: 1, y: 2 }, Array.from({ length: 101 }, (_, i) => ["행", i, i, i]))).toThrow("100종");
  expect(check({ type: "histogram", x: 1, y: 1 })).not.toThrow();
  expect(check({ type: "bar", series: [{ y: 1, axis: "left" }, { y: 2, axis: "right" }] })).not.toThrow();
});

it("writes native Excel area, horizontal bar and doughnut charts and refuses the rest for XLSX", async () => {
  const value = report(columns, sales, { type: "area" });
  value.result.charts!.push({ type: "bar", table: 0, x: 0, y: 1, title: "가로", horizontal: true }, { type: "pie", table: 0, x: 0, y: 1, title: "도넛", donut: true });
  const zip = await JSZip.loadAsync(await renderXlsx(value));
  const xml = await Promise.all([1, 2, 3].map(n => zip.file(`xl/charts/chart${n}.xml`)!.async("string")));
  for (const source of xml) new DOMParser({ onError: (_level, message) => { throw new Error(message); } }).parseFromString(source, "application/xml");
  expect(xml[0]).toContain('<c:areaChart><c:grouping val="standard"/>');
  expect(xml[1]).toContain('<c:barDir val="bar"/>');
  expect(xml[2]).toMatch(/<c:doughnutChart>.*<c:holeSize val="50"\/><\/c:doughnutChart>/);
  for (const chart of [{ type: "histogram" }, { type: "boxplot" }, { type: "heatmap", y: 1, value: 2 }, { type: "bar", series: [{ y: 1, axis: "left" }] }] as Partial<ChartSpec>[])
    await expect(renderXlsx(report(columns, sales, chart))).rejects.toThrow("XLSX는 막대·선·영역·산점도·원형 단일 시리즈");
});
