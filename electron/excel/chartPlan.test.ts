import { describe, expect, it } from "vitest";
import { compileChart, tgaAnnotations } from "./chartPlan.ts";
import { runAnalysis } from "./sandbox.ts";
import { chartOption } from "./chart.ts";
import { reportCharts, type ChartRequest, type ChartSpec, type InputRow, type Report } from "./contracts.ts";
import { resolveInputs } from "./resolveInputs.ts";
import { guessTable } from "./tableGuess.ts";

// A small run log: reactor, shift, cause, date, yield, minutes.
const raw: [string, string, string, string, number | null, number][] = [
  ["R1", "주간", "노즐", "2026-03-02", 26, 30], ["R1", "야간", "히터", "2026-03-09", 28, 60], ["R2", "주간", "노즐", "2026-03-03", 24, 10],
  ["R2", "주간", "전력", "2026-04-01", 22, 20], ["R3", "야간", "히터", "2026-04-15", 30, 90], ["R3", "야간", "노즐", "2026-04-20", null, 40],
];
const rows: InputRow[] = raw.map(([reactor, shift, cause, date, yieldValue, minutes], i) => ({ id: i + 1, fileId: "file1", sheet: "로그", row: i + 2, values: { reactor, shift, cause, date, yield: yieldValue, minutes } }));
const columns = ["reactor", "shift", "cause", "date", "yield", "minutes"].map((key, i) => ({ index: i + 1, name: key, key }));
const base = (extra: Partial<ChartRequest>): ChartRequest => ({
  kind: "chart", title: "t", format: "html", steps: ["그래프"], assumptions: [],
  input: { fileId: "file1", sheet: "로그", headerRow: 1, firstDataRow: 2, lastDataRow: 7, columns },
  x: { key: "reactor", label: "반응기", unit: "" }, series: [{ key: "yield", label: "수율", unit: "", axis: "left" }], ...extra,
} as ChartRequest);
async function run(extra: Partial<ChartRequest>) {
  const plan = compileChart(base(extra));
  const analysis = await runAnalysis(plan.code, rows);
  const chart = reportCharts({ result: analysis } as Report)[0];
  const table = (chart.dataset ? analysis.datasets! : analysis.tables)[chart.table];
  // Every input row is accounted for exactly once (validateResult already enforces it); rendering must not throw.
  chartOption({ result: analysis, plan, rowSources: {}, sources: [], summary: "", createdAt: "" } as unknown as Report, chart);
  return { plan, analysis, chart, table, cells: table.rows.map(r => r.cells), sources: table.rows.map(r => r.sourceRows) };
}

describe("compileChart grouped mode", () => {
  it("averages per category, keeps contributing rows and excludes blanks", async () => {
    const { cells, sources, analysis, chart } = await run({ chartType: "bar", agg: "mean", sort: "desc" });
    expect(cells).toEqual([["R3", 30], ["R1", 27], ["R2", 23]]);
    expect(sources).toEqual([[5], [1, 2], [3, 4]]);
    expect(analysis.excluded).toEqual([{ row: 6, reason: "값 열의 숫자 데이터 없음" }]);
    expect(chart).toMatchObject({ type: "bar", x: 0, y: 1 });
  });

  it("splits by a category into series, filling missing counts with 0", async () => {
    const { cells, chart, table } = await run({ chartType: "bar", agg: "count", series: [], by: { key: "shift" } });
    expect(table.columns).toEqual(["반응기", "야간", "주간"]);
    expect(cells).toEqual([["R1", 1, 1], ["R2", 0, 2], ["R3", 2, 0]]);
    expect(chart.series).toHaveLength(2);
  });

  it("filters, stacks sums by cause and leaves blanks as null for means", async () => {
    const stacked = await run({ chartType: "bar", agg: "sum", stack: true, series: [{ key: "minutes", label: "정지시간", unit: "분", axis: "left" }], by: { key: "cause" }, filter: ["reactor != R3"] });
    expect(stacked.cells).toEqual([["R1", 30, 0, 60], ["R2", 10, 20, 0]]);
    expect(stacked.chart).toMatchObject({ stack: true });
    expect(stacked.analysis.excluded.map(e => e.reason)).toEqual(["필터 제외: reactor != R3", "필터 제외: reactor != R3"]);
    const means = await run({ chartType: "bar", agg: "mean", by: { key: "shift" } });
    expect(means.cells[1]).toEqual(["R2", null, 23]);
  });

  it("keeps the top N slices of a pie and folds the rest into 기타", async () => {
    const { cells, sources } = await run({ chartType: "pie", agg: "count", series: [], x: { key: "cause", label: "원인", unit: "" }, sort: "desc", top: 2 });
    expect(cells).toEqual([["노즐", 3], ["히터", 2], ["기타", 1]]);
    expect(sources[2]).toEqual([4]);
  });

  it("builds a heatmap, monthly periods and numeric bins", async () => {
    const heat = await run({ chartType: "heatmap", agg: "mean", by: { key: "shift" } });
    expect(heat.cells).toEqual([["R1", "야간", 28], ["R1", "주간", 26], ["R2", "주간", 23], ["R3", "야간", 30]]);
    const monthly = await run({ chartType: "line", agg: "sum", x: { key: "date", label: "일자", unit: "", period: "month" }, series: [{ key: "minutes", label: "정지시간", unit: "분", axis: "left" }] });
    expect(monthly.cells).toEqual([["2026-03", 100], ["2026-04", 150]]);
    expect(monthly.table.columns[0]).toBe("일자 (월)");
    const binned = await run({ chartType: "bar", agg: "mean", x: { key: "minutes", label: "정지시간", unit: "분", bins: { width: 50, min: 0, max: 100 } } });
    expect(binned.cells).toEqual([["0–50", 24], ["50–100", 29]]);
  });

  it("draws a histogram with explicit edges and a moving average line", async () => {
    const hist = await run({ chartType: "histogram", series: [], x: { key: "minutes", label: "정지시간", unit: "분", bins: { edges: [0, 50, 100] } } });
    expect(hist.chart).toMatchObject({ type: "histogram", edges: [0, 50, 100], dataset: true });
    expect(hist.cells).toHaveLength(6);
    const ma = await run({ chartType: "line", x: { key: "minutes", label: "정지시간", unit: "분" }, movingAverage: { window: 2, keepRaw: true } });
    expect(ma.table.columns).toEqual(["정지시간 (분)", "수율", "수율 2점 이동평균"]);
    expect(ma.cells[1]).toEqual([60, 28, 27]);
  });

  it("drops XLSX for charts Excel cannot hold and says so instead of failing", () => {
    const plan = compileChart(base({ chartType: "bar", agg: "count", series: [], by: { key: "shift" }, formats: ["xlsx", "pdf"] }));
    expect(plan.formats ?? [plan.format]).toEqual(["pdf"]);
    expect(plan.notApplied?.[0]).toContain("XLSX");
  });

  it("leaves the legacy full-data chart program unchanged for replay", () => {
    const plan = compileChart(base({ x: { key: "minutes", label: "정지시간", unit: "분" } }));
    expect(plan.code).toContain("원본 측정 순서를 유지하며 유효한 전체 데이터를 표시했습니다.");
    expect(plan.code).not.toContain("필터 제외");
  });

  it("rejects an unparseable filter with the accepted forms", () => {
    expect(() => compileChart(base({ chartType: "bar", filter: ["반응기 R3만"] }))).toThrow(/열 == 값/);
  });
});

describe("resolveInputs adds columns named only in keys", () => {
  it("finds by / filter columns in the detected table", () => {
    const table = guessTable(3, 3, (r, c) => [["반응기", "근무조", "CNT수율"], ["R1", "주간", 26], ["R2", "야간", 24]][r - 1][c - 1])!;
    const resolved = resolveInputs({ kind: "chart", input: { sheet: "S", columns: [] }, x: { key: "반응기" }, series: [{ key: "CNT수율", axis: "left" }], by: { key: "근무조" }, filter: ["반응기 != R4"] }, [{ fileId: "file1", sheets: [{ name: "S", table }] }]) as { input: { columns: unknown[] } };
    expect(resolved.input.columns).toEqual([{ index: 1, name: "반응기", key: "반응기" }, { index: 3, name: "CNT수율", key: "CNT수율" }, { index: 2, name: "근무조", key: "근무조" }]);
  });
});

describe("tgaAnnotations", () => {
  const request = () => ({ x: { key: "t", label: "Temperature", unit: "°C" }, series: [{ key: "w", label: "Weight", unit: "%", axis: "left" }, { key: "d", label: "Deriv. Weight", unit: "%/°C", axis: "right" }] } as ChartRequest);
  const chart = { type: "line", table: 0, x: 0, y: 1, title: "", series: [{ y: 1, axis: "left" }, { y: 2, axis: "right" }] } as ChartSpec;
  const table = (xMax: number) => ({ rows: [100, 300, 500, xMax].map((x, i) => ({ cells: [x, 100 - i * 20, [0, -0.2, -0.9, -0.1][i]] })) });
  it("adds the residue at 800 °C and a downward DTG peak like the plotkit preset", () => {
    expect(tgaAnnotations(request(), chart, table(810))).toEqual([
      { series: 0, kind: "valueAt", x: 800, label: "Residue", format: "Residue {y:.1f}%" },
      { series: 1, kind: "peak", count: 1, xMin: 150, direction: "down", label: "DTG 피크", format: "{x:.0f} °C" },
    ]);
  });
  it("skips the residue when the run ends before 800 °C and ignores non-TGA charts", () => {
    expect(tgaAnnotations(request(), chart, table(750))?.map(a => a.kind)).toEqual(["peak"]);
    expect(tgaAnnotations({ ...request(), x: { key: "r", label: "반응기", unit: "" } } as ChartRequest, chart, table(810))).toBeUndefined();
  });
});
