import * as echarts from "echarts/core";
import { BarChart, BoxplotChart, HeatmapChart, LineChart, PieChart, ScatterChart } from "echarts/charts";
import { GraphicComponent, GridComponent, LegendComponent, MarkLineComponent, MarkPointComponent, TitleComponent, VisualMapComponent } from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import { chartSeries, chartTable, reportCharts, type ChartSpec, type Report } from "./contracts.ts";
import { sourceFor } from "./sources.ts";
import { ExcelError } from "./limits.ts";
import { numericX, type AxisView } from "./view.ts";

echarts.use([BarChart, BoxplotChart, HeatmapChart, LineChart, PieChart, ScatterChart, GraphicComponent, GridComponent, LegendComponent, MarkLineComponent, MarkPointComponent, TitleComponent, VisualMapComponent, SVGRenderer]);

type Axis = Record<string, unknown>;
export type ChartSeriesOption = { type: string; name?: string; data: unknown[]; [key: string]: unknown };
/** The ECharts option plus the text notes drawn under the plot; tests assert on this instead of SVG coordinates. */
export type ChartRender = { option: { xAxis?: Axis; yAxis?: Axis | Axis[]; series: ChartSeriesOption[]; [key: string]: unknown }; notes: string[]; width: number; height: number };

const FONT = "Arial,'Malgun Gothic','Apple SD Gothic Neo',sans-serif";
const PALETTE = ["#2563eb", "#dc2626", "#16803c", "#9333ea", "#d97706", "#0891b2", "#be185d", "#4d7c0f"];
const WIDTH = 960, PLOT = 460, INK = "#18181b", RULE = "#71717a";

const label = (value: number, axis?: AxisView) => {
  const text = axis?.decimals === undefined ? Number(value.toPrecision(5)).toString() : value.toFixed(axis.decimals);
  return Number(text) === 0 ? text.replace(/^-/, "") : text;
};

export function chartScale(values: number[], axis: AxisView = {}) {
  const min = axis.min ?? Math.min(...values, ...(axis.tickValues ?? []));
  const max = axis.max ?? Math.max(...values, ...(axis.tickValues ?? []));
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) throw new ExcelError("UNSUPPORTED", "축 범위가 데이터와 맞지 않습니다. 최소·최대값을 함께 지정해 주세요.");
  let ticks = axis.tickValues;
  if (!ticks && axis.tickStep) {
    const count = Math.floor((max - min) / axis.tickStep + 1e-9) + 1;
    if (!Number.isFinite(count) || count > 50) throw new ExcelError("UNSUPPORTED", "축 눈금은 최대 50개입니다. 눈금 간격을 늘려 주세요.");
    ticks = Array.from({ length: count }, (_, i) => Math.abs(min + i * axis.tickStep! - max) <= Math.max(1, Math.abs(max)) * 1e-12 ? max : min + i * axis.tickStep!);
  }
  if (!ticks) {
    ticks = min === max ? [min] : Array.from({ length: 5 }, (_, i) => min * (1 - i / 4) + max * i / 4);
    // Rounded automatic ticks must use their real positions, without repeated labels.
    if (axis.decimals !== undefined && min !== max) ticks = [...new Set(ticks.map(value => Number(value.toFixed(axis.decimals))))];
  }
  return { min, max, ticks: ticks.filter(v => v >= min && v <= max) };
}

/** Explicit ticks are passed through exactly; otherwise ECharts picks rounded ticks inside any requested range. */
function valueAxis(values: number[], view: AxisView | undefined, name: string, zeroBased: boolean, grid: "none" | "solid" | "dashed" = "solid"): Axis {
  const log = view?.scale === "log";
  if (log && [...values, view.min ?? 1, ...(view.tickValues ?? [])].some(value => value <= 0)) throw new ExcelError("UNSUPPORTED", "로그 축에는 0보다 큰 값만 표시할 수 있습니다. 축 범위나 데이터를 확인해 주세요.");
  const axisLabel: Record<string, unknown> = { color: INK, fontSize: 11, hideOverlap: true, formatter: (value: number) => label(value, view) };
  const axis: Axis = {
    type: log ? "log" : "value", scale: !zeroBased, name, nameLocation: "middle", nameTextStyle: { color: INK, fontSize: 13 },
    axisLine: { show: true, lineStyle: { color: RULE } }, axisTick: { show: true }, splitLine: { show: grid !== "none", lineStyle: grid === "dashed" ? { color: "#a1a1aa", type: "dashed" } : { color: "#e4e4e7" } }, axisLabel,
  };
  if (view?.min !== undefined) axis.min = view.min;
  if (view?.max !== undefined) axis.max = view.max;
  if (view?.tickValues || view?.tickStep) {
    const scale = chartScale(values, view);
    Object.assign(axis, { min: scale.min, max: scale.max, axisTick: { show: true, customValues: scale.ticks } });
    axisLabel.customValues = scale.ticks;
  } else if (view?.decimals !== undefined && !log) axis.minInterval = 10 ** -view.decimals;
  return axis;
}

const categoryAxis = (names: string[], name: string): Axis => ({
  type: "category", data: names, name, nameLocation: "middle", nameTextStyle: { color: INK, fontSize: 13 },
  axisLine: { show: true, lineStyle: { color: RULE } }, axisLabel: { color: INK, fontSize: 11, hideOverlap: true },
});

const bounds = (axis?: AxisView) => [axis?.min ?? -Infinity, axis?.max ?? Infinity] as const;
const quantile = (sorted: number[], p: number) => {
  const at = (sorted.length - 1) * p, low = Math.floor(at);
  return sorted[low] + (sorted[Math.min(low + 1, sorted.length - 1)] - sorted[low]) * (at - low);
};

/** Lines keep acquisition order and break at missing source rows; no point is sampled away. */
export function chartOption(report: Report, chart: ChartSpec): ChartRender {
  const data = chartTable(report, chart)!;
  const view = report.view?.charts[String(reportCharts(report).indexOf(chart))] ?? {};
  const colors = [...(view.colors ?? []), ...PALETTE], notes: string[] = [];
  const series = chartSeries(chart), names = data.rows.map(row => String(row.cells[chart.x] ?? ""));
  const valueLabel = view.labels ? { show: true, fontSize: 10, color: INK } : undefined;
  const option: ChartRender["option"] = { series: [] };
  let legend: string[] = [], rightAxis = false;

  if (chart.type === "pie") {
    option.series = [{
      type: "pie", radius: chart.donut ? ["36%", "62%"] : "62%", center: ["50%", "55%"], data: data.rows.map((row, i) => ({ name: names[i], value: row.cells[chart.y] })),
      label: { formatter: "{b}: {c} ({d}%)", fontSize: 11, color: INK }, labelLayout: { hideOverlap: true }, itemStyle: { borderColor: "#fff", borderWidth: 1 },
    }];
  } else if (chart.type === "heatmap") {
    const xs = [...new Set(names)], ys = [...new Set(data.rows.map(row => String(row.cells[chart.y] ?? "")))];
    const cells = new Map<string, [number, number, number]>();
    for (const [i, row] of data.rows.entries()) cells.set(`${names[i]}\u0000${row.cells[chart.y]}`, [xs.indexOf(names[i]), ys.indexOf(String(row.cells[chart.y] ?? "")), Number(row.cells[chart.value!])]);
    if (cells.size < data.rows.length) notes.push(`같은 칸의 값 ${data.rows.length - cells.size}개는 마지막 값으로 표시했습니다.`);
    const values = [...cells.values()].map(cell => cell[2]);
    option.xAxis = { ...categoryAxis(xs, view.axes?.x?.label ?? data.columns[chart.x]), splitArea: { show: true } };
    option.yAxis = { ...categoryAxis(ys, data.columns[chart.y]), splitArea: { show: true } };
    option.visualMap = { min: Math.min(...values), max: Math.max(...values), calculable: false, orient: "vertical", right: 12, top: "middle", text: [data.columns[chart.value!], ""], textStyle: { color: INK, fontSize: 11 }, inRange: { color: view.colors && view.colors.length > 1 ? view.colors : ["#eff6ff", "#2563eb"] } };
    option.series = [{ type: "heatmap", data: [...cells.values()], label: { show: cells.size <= 400, fontSize: 10, color: INK }, itemStyle: { borderColor: "#fff", borderWidth: 1 } }];
    rightAxis = true;
  } else if (chart.type === "histogram") {
    const values = data.rows.map(row => Number(row.cells[chart.y]));
    const low = Math.min(...values), high = Math.max(...values);
    const bins = low === high ? 1 : chart.bins ?? Math.max(5, Math.min(50, Math.ceil(Math.log2(values.length)) + 1));
    const width = (high - low) / bins || 1, counts = Array<number>(bins).fill(0);
    for (const value of values) counts[Math.min(bins - 1, Math.floor((value - low) / width))]++;
    option.xAxis = categoryAxis(counts.map((_, i) => `${label(low + i * width)}–${label(low + (i + 1) * width)}`), view.axes?.x?.label ?? data.columns[chart.y]);
    option.yAxis = valueAxis(counts, view.axes?.left, view.axes?.left?.label ?? "빈도", true, view.grid);
    option.series = [{ type: "bar", name: "빈도", data: counts, barCategoryGap: "4%", label: valueLabel && { ...valueLabel, position: "top" } }];
    notes.push(`구간 ${bins}개 · 구간 폭 ${label(width)} · 전체 ${values.length.toLocaleString("en-US")}개 값`);
  } else if (chart.type === "boxplot") {
    const groups = new Map<string, number[]>();
    for (const [i, row] of data.rows.entries()) groups.set(names[i], [...(groups.get(names[i]) ?? []), Number(row.cells[chart.y])]);
    const boxes: number[][] = [], outliers: number[][] = [];
    for (const [index, values] of [...groups.values()].entries()) {
      const sorted = values.sort((a, b) => a - b), q1 = quantile(sorted, .25), q3 = quantile(sorted, .75), reach = (q3 - q1) * 1.5;
      const inside = sorted.filter(value => value >= q1 - reach && value <= q3 + reach);
      boxes.push([inside[0], q1, quantile(sorted, .5), q3, inside.at(-1)!]);
      for (const value of sorted) if (value < q1 - reach || value > q3 + reach) outliers.push([index, value]);
    }
    option.xAxis = categoryAxis([...groups.keys()], view.axes?.x?.label ?? data.columns[chart.x]);
    option.yAxis = valueAxis(data.rows.map(row => Number(row.cells[chart.y])), view.axes?.left, view.axes?.left?.label ?? data.columns[chart.y], false, view.grid);
    option.series = [{ type: "boxplot", name: data.columns[chart.y], data: boxes, itemStyle: { color: "#dbeafe", borderColor: colors[0] } }];
    if (outliers.length) option.series.push({ type: "scatter", name: "이상치", data: outliers, symbolSize: 5, itemStyle: { color: colors[1] } });
    notes.push(`상자는 1·3사분위수와 중앙값, 수염은 1.5×IQR 이내 범위${outliers.length ? `, 이상치 ${outliers.length}개` : ""}`);
  } else {
    const numeric = numericX(chart), horizontal = Boolean(chart.horizontal);
    const xs = data.rows.map((row, i) => numeric ? Number(row.cells[chart.x]) : i);
    const point = (x: number, y: number | null) => horizontal ? [y, x] : [x, y];
    const [xMin, xMax] = numeric ? bounds(view.axes?.x) : bounds();
    rightAxis = series.some(item => item.axis === "right");
    const sides = (["left", "right"] as const).filter(side => series.some(item => item.axis === side));
    const valueAxes = sides.map(side => valueAxis(
      series.filter(item => item.axis === side).flatMap(item => data.rows.map(row => Number(row.cells[item.y]))), view.axes?.[side],
      view.axes?.[side]?.label ?? series.filter(item => item.axis === side).map(item => data.columns[item.y]).join(" / "), chart.type === "bar" || Boolean(chart.stack), view.grid,
    ));
    const baseAxis = numeric ? valueAxis(xs, view.axes?.x, view.axes?.x?.label ?? data.columns[chart.x], false, view.grid) : categoryAxis(names, view.axes?.x?.label ?? data.columns[chart.x]);
    option.xAxis = horizontal ? valueAxes[0] : baseAxis;
    option.yAxis = horizontal ? { ...baseAxis, inverse: true } : valueAxes;
    const refs = chart.dataset ? data.rows.map(row => sourceFor(report.rowSources, row.sourceRows[0])) : [];
    const gaps = data.rows.map((_, i) => {
      const before = refs[i - 1], current = refs[i];
      return i > 0 && Boolean(chart.dataset && (!before || !current || before.fileId !== current.fileId || before.sheet !== current.sheet || before.rangeId !== current.rangeId || current.row !== before.row + 1));
    });
    const connected = chart.type === "line" || chart.type === "area";
    for (const [index, item] of series.entries()) {
      const [yMin, yMax] = bounds(view.axes?.[item.axis]);
      const name = data.columns[item.y] + (rightAxis ? ` (${item.axis === "left" ? "왼쪽" : "오른쪽"} 축)` : ""), color = colors[index];
      const values = data.rows.map(row => Number(row.cells[item.y]));
      const points: unknown[] = [], isolated: unknown[] = [];
      let outside = 0;
      for (const [i, value] of values.entries()) {
        // A null item is how ECharts lifts the pen; the measured points themselves are all kept.
        if (connected && gaps[i]) points.push(point(xs[i], null));
        points.push(point(xs[i], value));
        if (connected && (i === 0 || gaps[i]) && (i === values.length - 1 || gaps[i + 1])) isolated.push(point(xs[i], value));
        if (xs[i] < xMin || xs[i] > xMax || value < yMin || value > yMax) outside++;
      }
      if (outside) notes.push(`${data.columns[item.y]}: 표시 범위 밖 ${outside}점 (데이터 유지)`);
      const entry: ChartSeriesOption = {
        type: chart.type === "area" ? "line" : chart.type, name, data: points, yAxisIndex: horizontal ? 0 : sides.indexOf(item.axis), itemStyle: { color },
        label: valueLabel && { ...valueLabel, position: horizontal ? "right" : "top", formatter: (params: { value: unknown[] }) => label(Number(params.value[horizontal ? 0 : 1])) },
      };
      if (connected) Object.assign(entry, { showSymbol: Boolean(view.labels) || values.length <= 60, symbolSize: 5, smooth: Boolean(chart.smooth), connectNulls: false, lineStyle: { width: 1.5, color }, ...(chart.type === "area" ? { areaStyle: { opacity: .25 } } : {}), ...(chart.stack ? { stack: item.axis } : {}) });
      if (chart.type === "scatter") entry.symbolSize = values.length > 2000 ? 3 : 5;
      if (chart.type === "bar") Object.assign(entry, { barMaxWidth: 48, ...(chart.stack ? { stack: item.axis } : {}) });
      const marks: unknown[] = [], lines: unknown[] = [];
      for (const annotation of (view.annotations ?? []).filter(annotation => annotation.series === index)) {
        const visible = values.map((value, i) => annotation.scope !== "visibleData" || xs[i] >= xMin && xs[i] <= xMax && value >= yMin && value <= yMax);
        const candidates = values.filter((_, i) => visible[i]);
        if (!candidates.length) { notes.push(`${annotation.label}: 표시 범위에 데이터 없음`); continue; }
        if (annotation.kind === "mean") {
          const mean = candidates.reduce((sum, value) => sum + value / candidates.length, 0);
          lines.push({ [horizontal ? "xAxis" : "yAxis"]: mean, label: { formatter: `${annotation.label}: ${label(mean)}`, position: "insideEndTop", color: INK, fontSize: 12 } });
          notes.push(`${annotation.label}: ${data.columns[item.y]} = ${label(mean)} (${candidates.length.toLocaleString("en-US")}점)`);
          continue;
        }
        let selected: number, ties = 1;
        if (annotation.kind === "valueAt") {
          // The nearest measured point is shown as measured; nothing is interpolated.
          selected = xs.reduce((best, x, i) => visible[i] && (best < 0 || Math.abs(x - annotation.x!) < Math.abs(xs[best] - annotation.x!)) ? i : best, -1);
        } else {
          const extreme = annotation.kind === "max" ? Math.max(...candidates) : Math.min(...candidates);
          selected = values.findIndex((value, i) => visible[i] && value === extreme);
          ties = candidates.filter(value => value === extreme).length;
        }
        const target = values[selected];
        const text = `${annotation.label}: X=${numeric ? label(xs[selected], view.axes?.x) : names[selected]}, Y=${label(target)}`;
        const inside = xs[selected] >= xMin && xs[selected] <= xMax && target >= yMin && target <= yMax;
        if (inside) {
          marks.push({ coord: point(xs[selected], target), name: annotation.kind, label: { formatter: text } });
          // A dashed guide drops from the marked point to the base axis so its position can be read off.
          lines.push({ [horizontal ? "yAxis" : "xAxis"]: numeric ? xs[selected] : names[selected], lineStyle: { color, type: "dashed" }, label: { show: false } });
        }
        const nearest = annotation.kind === "valueAt" && xs[selected] !== annotation.x ? ` · 요청 X=${label(annotation.x!)}에 가장 가까운 측정점 (X=${label(xs[selected])})` : "";
        notes.push(`${text}${nearest}${ties > 1 ? ` · 동률 ${ties}점 중 첫 측정점` : ""}${inside ? "" : " · 표시 범위 밖"}`);
      }
      if (marks.length) entry.markPoint = { symbol: "circle", symbolSize: 9, itemStyle: { color, borderColor: "#fff", borderWidth: 1 }, label: { show: true, position: "top", color: INK, fontSize: 12 }, data: marks };
      if (lines.length) entry.markLine = { symbol: "none", lineStyle: { color, type: "dashed" }, data: lines };
      const guides = (view.referenceLines ?? []).filter(line => line.axis === item.axis && series.findIndex(other => other.axis === line.axis) === index || line.axis === "x" && index === 0);
      if (guides.length) entry.markLine = {
        symbol: "none", lineStyle: { color, type: "dashed" },
        data: [...lines, ...guides.map(line => ({ [(line.axis === "x") !== horizontal ? "xAxis" : "yAxis"]: line.value, lineStyle: { color: "#52525b", type: "dashed" }, label: { formatter: line.label ?? label(line.value, view.axes?.[line.axis]), position: line.axis === "x" ? "end" : "insideEndTop", color: INK, fontSize: 12 } }))],
      };
      option.series.push(entry);
      // A lone measurement between two gaps has no segment to draw, so it gets a visible point.
      if (isolated.length && !entry.showSymbol) option.series.push({ type: "scatter", data: isolated, yAxisIndex: entry.yAxisIndex, symbolSize: 5, itemStyle: { color }, isolated: index });
      legend.push(name);
    }
    if (chart.type === "scatter" && chart.trendline) {
      const ys = data.rows.map(row => Number(row.cells[chart.y]));
      const scaleX = Math.max(1, ...xs.map(Math.abs)), scaleY = Math.max(1, ...ys.map(Math.abs));
      const nx = xs.map(v => v / scaleX), ny = ys.map(v => v / scaleY);
      const mx = nx.reduce((a, b) => a + b, 0) / nx.length, my = ny.reduce((a, b) => a + b, 0) / ny.length;
      const spread = nx.reduce((sum, v) => sum + (v - mx) ** 2, 0);
      if (spread > 0) {
        const slope = nx.reduce((sum, v, i) => sum + (v - mx) * (ny[i] - my), 0) / spread;
        const ends = [Math.max(xMin, Math.min(...xs)), Math.min(xMax, Math.max(...xs))].map(x => [x, (my + slope * (x / scaleX - mx)) * scaleY]);
        if (ends.flat().every(Number.isFinite)) { option.series.push({ type: "line", name: "추세선", data: ends, showSymbol: false, lineStyle: { color: "#dc2626", type: "dashed", width: 1.5 }, itemStyle: { color: "#dc2626" } }); legend.push("추세선"); }
      }
    }
    if (legend.length < 2) legend = [];
  }

  const title = view.title ?? chart.title, height = PLOT + (notes.length ? notes.length * 18 + 12 : 0);
  const bottom = legend.length ? 96 : 66;
  for (const axis of [option.xAxis, ...[option.yAxis ?? []].flat()]) if (axis) axis.nameGap = axis === option.xAxis ? 32 : axis.type === "category" ? 100 : 58;
  Object.assign(option, {
    animation: false, backgroundColor: "#fff", color: colors, textStyle: { fontFamily: FONT, color: INK },
    title: { text: title, left: 16, top: 10, textStyle: { fontSize: 18, fontWeight: "normal", color: INK } },
    ...(option.xAxis ? { grid: { left: chart.horizontal ? 130 : 90, right: rightAxis ? 90 : 40, top: 56, height: PLOT - 56 - bottom } } : {}),
    ...(legend.length ? { legend: { data: legend, top: PLOT - 34, left: "center", textStyle: { color: INK, fontSize: 12 } } } : {}),
    graphic: notes.map((note, i) => ({ type: "text", left: 16, top: PLOT + 4 + i * 18, silent: true, style: { text: note, fontSize: 11, fill: INK, fontFamily: FONT } })),
  });
  return { option, notes, width: WIDTH, height };
}

const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/** Server-side SVG: static markup without scripts, safe for the report CSP and for PDF/PNG capture. */
export function chartSvg(report: Report, chart: ChartSpec | undefined = reportCharts(report)[0]): string {
  if (!chart) return "";
  const index = reportCharts(report).indexOf(chart), { option, width, height } = chartOption(report, chart);
  const instance = echarts.init(null, null, { renderer: "svg", ssr: true, width, height });
  try {
    instance.setOption(option);
    // ECharts numbers ids and style classes per process; renumbering per chart keeps reports reproducible and collision-free.
    const classes = new Map<string, number>();
    return instance.renderToSVGString().replace(/zr\d+-cls-(\d+)/g, (_match, id: string) => `chart${index}-cls-${classes.get(id) ?? classes.set(id, classes.size).get(id)}`)
      .replace(/zr\d+-/g, `chart${index}-`)
      .replace(/^<svg /, `<svg role="img" aria-label="${escape(report.view?.charts[String(index)]?.title ?? chart.title)}" `);
  } finally { instance.dispose(); }
}
