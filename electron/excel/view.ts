import { axisView, reportView, viewPatch, type ReportView, type ViewPatch } from "./viewContracts.ts";
export { reportView, viewPatch } from "./viewContracts.ts";
export type { ReportView, ViewPatch, AxisView } from "./viewContracts.ts";
import { chartSeries, chartTable, reportCharts, type Report } from "./contracts.ts";
import { ExcelError } from "./limits.ts";

/** Omitted fields survive each turn; null restores automatic settings, [] clears annotations. */
export function mergeView(current: ReportView | undefined, raw: ViewPatch): ReportView {
  const next = structuredClone(current ?? { charts: {} });
  for (const [id, patch] of Object.entries(viewPatch.parse(raw).charts)) {
    const chart = next.charts[id] ??= {};
    for (const key of ["title", "description"] as const) {
      if (patch[key] === null) delete chart[key];
      else if (patch[key] !== undefined) chart[key] = patch[key];
    }
    for (const side of ["x", "left", "right"] as const) {
      const update = patch.axes?.[side];
      if (update === undefined) continue;
      chart.axes ??= {};
      if (update === null) { delete chart.axes[side]; continue; }
      const axis = { ...chart.axes[side], ...update };
      if (update.tickStep != null) delete axis.tickValues;
      if (update.tickValues != null) delete axis.tickStep;
      chart.axes[side] = axisView.parse(Object.fromEntries(Object.entries(axis).filter(([, value]) => value !== null)));
    }
    if (patch.annotations) {
      if (!patch.annotations.length) chart.annotations = [];
      else {
        const annotations = chart.annotations ?? [];
        for (const item of patch.annotations) {
          const index = annotations.findIndex(old => old.series === item.series && old.scope === item.scope);
          if (index < 0) annotations.push(item); else annotations[index] = item;
        }
        chart.annotations = annotations;
      }
    }
  }
  return reportView.parse(next);
}

export function validateView(report: Report) {
  const view = reportView.parse(report.view ?? { charts: {} }), charts = reportCharts(report);
  for (const [id, settings] of Object.entries(view.charts)) {
    const chart = charts[Number(id)];
    if (!chart) throw new ExcelError("UNSUPPORTED", `수정할 차트 ${Number(id) + 1}이 없습니다.`);
    if ((settings.axes || settings.annotations?.length) && chart.type !== "line" && chart.type !== "scatter") throw new ExcelError("UNSUPPORTED", "축·최대점 수정은 선 그래프와 산점도에서 지원합니다.");
    if (settings.axes?.right && !chartSeries(chart).some(series => series.axis === "right")) throw new ExcelError("UNSUPPORTED", "이 그래프에는 오른쪽 Y축이 없습니다.");
    if (chart.type === "line" && chart.xScale !== "linear" && settings.axes?.x && Object.keys(settings.axes.x).some(key => key !== "label")) throw new ExcelError("UNSUPPORTED", "숫자형 X축에서만 범위와 눈금을 수정할 수 있습니다.");
    for (const item of settings.annotations ?? []) if (!chartSeries(chart)[item.series]) throw new ExcelError("UNSUPPORTED", "최대점을 표시할 시리즈가 없습니다.");
  }
}

export function viewSummary(before: ReportView | undefined, after: ReportView): string[] {
  const changes: string[] = [];
  const names = { min: "최소", max: "최대", tickStep: "눈금 간격", tickValues: "눈금", decimals: "소수 자릿수", label: "라벨" };
  for (const [id, chart] of Object.entries(after.charts)) {
    const old = before?.charts[id] ?? {};
    const prefix = `차트 ${Number(id) + 1}`;
    for (const key of ["title", "description"] as const) if (chart[key] !== old[key]) changes.push(`${prefix} ${key === "title" ? "제목" : "설명"}: ${chart[key] ?? "기본값"}`);
    for (const side of ["x", "left", "right"] as const) for (const key of Object.keys(names) as (keyof typeof names)[]) {
      const value = chart.axes?.[side]?.[key];
      if (JSON.stringify(value) !== JSON.stringify(old.axes?.[side]?.[key])) changes.push(`${prefix} ${side === "x" ? "X" : side === "left" ? "왼쪽 Y" : "오른쪽 Y"} ${names[key]}: ${Array.isArray(value) ? value.join(", ") : value ?? "자동"}`);
    }
    if (JSON.stringify(chart.annotations) !== JSON.stringify(old.annotations)) changes.push(`${prefix} 최대점: ${chart.annotations?.length ? chart.annotations.map(item => `${item.label} (시리즈 ${item.series + 1})`).join(", ") : "표시 해제"}`);
  }
  return changes;
}

/** A small model context: identities and confirmed view only, never rows, generated code or profiles. */
export function chartContext(report: Report) {
  return reportCharts(report).map((chart, index) => ({ index, type: chart.type, title: chart.title, x: chartTable(report, chart)?.columns[chart.x], series: chartSeries(chart).map((series, i) => ({ index: i, label: chartTable(report, chart)?.columns[series.y], axis: series.axis })) }));
}
