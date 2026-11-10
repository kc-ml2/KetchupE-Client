import { annotationLabels, axisView, reportView, viewPatch, type ReportView, type ViewPatch } from "./viewContracts.ts";
export { reportView, viewPatch } from "./viewContracts.ts";
export type { ReportView, ViewPatch, AxisView } from "./viewContracts.ts";
import { chartSeries, chartTable, reportCharts, type ChartSpec, type Report } from "./contracts.ts";
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
    if (patch.labels === null) delete chart.labels; else if (patch.labels !== undefined) chart.labels = patch.labels;
    if (patch.colors === null) delete chart.colors; else if (patch.colors !== undefined) chart.colors = patch.colors;
    if (patch.grid === null) delete chart.grid; else if (patch.grid !== undefined) chart.grid = patch.grid;
    // Reference lines have no identity to merge on, so a patch states the whole list; [] or null removes them.
    if (patch.referenceLines === null || patch.referenceLines?.length === 0) delete chart.referenceLines; else if (patch.referenceLines) chart.referenceLines = patch.referenceLines;
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
          const index = annotations.findIndex(old => old.series === item.series && old.scope === item.scope && old.kind === item.kind && old.x === item.x);
          const annotation = { ...item, label: item.label ?? annotations[index]?.label ?? annotationLabels[item.kind] };
          if (index < 0) annotations.push(annotation); else annotations[index] = annotation;
        }
        chart.annotations = annotations;
      }
    }
  }
  return reportView.parse(next);
}

/** Line and area charts use a numeric X only on request; scatter always does. */
export const numericX = (chart: ChartSpec) => chart.type === "scatter" || chart.xScale === "linear" && (chart.type === "line" || chart.type === "area");

export function validateView(report: Report) {
  const view = reportView.parse(report.view ?? { charts: {} }), charts = reportCharts(report);
  for (const [id, settings] of Object.entries(view.charts)) {
    const chart = charts[Number(id)];
    if (!chart) throw new ExcelError("UNSUPPORTED", `수정할 차트 ${Number(id) + 1}이 없습니다.`);
    const cartesian = chart.type !== "pie" && chart.type !== "heatmap";
    if (settings.axes && !cartesian) throw new ExcelError("UNSUPPORTED", "원형 차트와 히트맵은 축 수정을 지원하지 않습니다.");
    if (settings.annotations?.length && !["line", "area", "scatter", "bar"].includes(chart.type)) throw new ExcelError("UNSUPPORTED", "최대·최소·평균 표시는 선·영역·산점도·막대 그래프에서 지원합니다.");
    if (settings.axes?.right && !chartSeries(chart).some(series => series.axis === "right")) throw new ExcelError("UNSUPPORTED", "이 그래프에는 오른쪽 Y축이 없습니다.");
    if (!numericX(chart) && settings.axes?.x && Object.keys(settings.axes.x).some(key => key !== "label")) throw new ExcelError("UNSUPPORTED", "숫자형 X축에서만 범위·눈금·로그 스케일을 수정할 수 있습니다.");
    for (const axis of Object.values(settings.axes ?? {})) if (axis?.scale === "log" && axis.tickStep !== undefined) throw new ExcelError("UNSUPPORTED", "로그 축의 눈금은 간격 대신 tickValues로 지정해 주세요.");
    if (settings.labels && (chartTable(report, chart)?.rows.length ?? 0) > 500) throw new ExcelError("UNSUPPORTED", "값 라벨은 500점 이하 차트에서 지원합니다.");
    if ((settings.grid || settings.referenceLines) && !cartesian) throw new ExcelError("UNSUPPORTED", "원형 차트와 히트맵은 그리드·보조선을 지원하지 않습니다.");
    for (const line of settings.referenceLines ?? []) {
      if (line.axis === "x" && !numericX(chart)) throw new ExcelError("UNSUPPORTED", "세로 보조선은 숫자형 X축에서 지원합니다.");
      if (line.axis === "right" && !chartSeries(chart).some(series => series.axis === "right")) throw new ExcelError("UNSUPPORTED", "이 그래프에는 오른쪽 Y축이 없습니다.");
    }
    if (settings.annotations?.some(item => item.kind === "valueAt") && !numericX(chart)) throw new ExcelError("UNSUPPORTED", "특정 X의 값 표시는 숫자형 X축에서 지원합니다.");
    for (const item of settings.annotations ?? []) if (!chartSeries(chart)[item.series]) throw new ExcelError("UNSUPPORTED", "값을 표시할 시리즈가 없습니다.");
  }
}

export function viewSummary(before: ReportView | undefined, after: ReportView): string[] {
  const changes: string[] = [];
  const names = { min: "최소", max: "최대", tickStep: "눈금 간격", tickValues: "눈금", decimals: "소수 자릿수", label: "라벨", scale: "스케일" };
  for (const [id, chart] of Object.entries(after.charts)) {
    const old = before?.charts[id] ?? {};
    const prefix = `차트 ${Number(id) + 1}`;
    for (const key of ["title", "description"] as const) if (chart[key] !== old[key]) changes.push(`${prefix} ${key === "title" ? "제목" : "설명"}: ${chart[key] ?? "기본값"}`);
    for (const side of ["x", "left", "right"] as const) for (const key of Object.keys(names) as (keyof typeof names)[]) {
      const value = chart.axes?.[side]?.[key];
      if (JSON.stringify(value) !== JSON.stringify(old.axes?.[side]?.[key])) changes.push(`${prefix} ${side === "x" ? "X" : side === "left" ? "왼쪽 Y" : "오른쪽 Y"} ${names[key]}: ${Array.isArray(value) ? value.join(", ") : value ?? "자동"}`);
    }
    if (JSON.stringify(chart.annotations) !== JSON.stringify(old.annotations)) changes.push(`${prefix} 값 표시: ${chart.annotations?.length ? chart.annotations.map(item => `${item.label} (시리즈 ${item.series + 1})`).join(", ") : "표시 해제"}`);
    if (chart.grid !== old.grid) changes.push(`${prefix} 그리드: ${chart.grid === "none" ? "숨김" : chart.grid === "dashed" ? "점선" : chart.grid === "solid" ? "실선" : "기본값"}`);
    if (JSON.stringify(chart.referenceLines) !== JSON.stringify(old.referenceLines)) changes.push(`${prefix} 보조선: ${chart.referenceLines?.map(line => `${line.axis === "x" ? "X" : line.axis === "left" ? "왼쪽 Y" : "오른쪽 Y"}=${line.value}`).join(", ") ?? "없음"}`);
    if (chart.labels !== old.labels) changes.push(`${prefix} 값 라벨: ${chart.labels ? "표시" : "숨김"}`);
    if (JSON.stringify(chart.colors) !== JSON.stringify(old.colors)) changes.push(`${prefix} 색상: ${chart.colors?.join(", ") ?? "기본값"}`);
  }
  return changes;
}

/** A small model context: identities and confirmed view only, never rows, generated code or profiles. */
export function chartContext(report: Report) {
  return reportCharts(report).map((chart, index) => ({ index, type: chart.type, title: chart.title, x: chartTable(report, chart)?.columns[chart.x], series: chartSeries(chart).map((series, i) => ({ index: i, label: chartTable(report, chart)?.columns[series.y], axis: series.axis })), numericX: numericX(chart) }));
}
