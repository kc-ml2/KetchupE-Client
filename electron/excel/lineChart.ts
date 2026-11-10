import { chartSeries, chartTable, reportCharts, type ChartSpec, type Report } from "./contracts.ts";
import { sourceFor } from "./sources.ts";
import { ExcelError } from "./limits.ts";
import type { AxisView } from "./view.ts";

const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const label = (value: number, axis?: AxisView) => axis?.decimals === undefined ? Number(value.toPrecision(5)).toString() : value.toFixed(axis.decimals);
export function chartScale(values: number[], axis: AxisView = {}) {
  const min = axis.min ?? Math.min(...values, ...(axis.tickValues ?? []));
  const max = axis.max ?? Math.max(...values, ...(axis.tickValues ?? []));
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) throw new ExcelError("UNSUPPORTED", "축 범위가 데이터와 맞지 않습니다. 최소·최대값을 함께 지정해 주세요.");
  const magnitude = Math.max(Math.abs(min), Math.abs(max), 1);
  const start = min / magnitude, span = (max / magnitude - start) || 1;
  const position = (value: number) => min === max ? 0.5 : (value / magnitude - start) / span;
  let ticks = axis.tickValues;
  if (!ticks && axis.tickStep) {
    const count = Math.floor((max - min) / axis.tickStep + 1e-9) + 1;
    if (!Number.isFinite(count) || count > 50) throw new ExcelError("UNSUPPORTED", "축 눈금은 최대 50개입니다. 눈금 간격을 늘려 주세요.");
    ticks = Array.from({ length: count }, (_, i) => Math.abs(min + i * axis.tickStep! - max) <= Math.max(1, Math.abs(max)) * 1e-12 ? max : min + i * axis.tickStep!);
  }
  ticks ??= min === max ? [min] : Array.from({ length: 5 }, (_, i) => min * (1 - i / 4) + max * i / 4);
  return { min, max, position, ticks: ticks.filter(v => v >= min && v <= max) };
}

/** Paths preserve acquisition order and break at missing source rows; no point decimation. */
export function lineChartSvg(report: Report, chart: ChartSpec): string {
  const data = chartTable(report, chart)!;
  const chartIndex = reportCharts(report).indexOf(chart), view = report.view?.charts[String(chartIndex)] ?? {};
  const series = chartSeries(chart), numericX = chart.xScale === "linear" || chart.type === "scatter";
  const xs = data.rows.map((row, index) => numericX ? Number(row.cells[chart.x]) : index);
  const x = chartScale(xs, view.axes?.x), colors = ["#2563eb", "#dc2626", "#16803c", "#9333ea"];
  const axes = new Map<"left" | "right", ReturnType<typeof chartScale>>();
  for (const side of ["left", "right"] as const) {
    const columns = series.filter(item => item.axis === side);
    if (columns.length) axes.set(side, chartScale(columns.flatMap(item => data.rows.map(row => Number(row.cells[item.y]))), view.axes?.[side]));
  }
  const clipId = `plot-${chartIndex}`;
  let content = `<defs><clipPath id="${clipId}"><rect x="120" y="60" width="720" height="300"/></clipPath></defs><path d="M120 60 V360 H840" fill="none" stroke="#71717a"/>`;
  for (const [side, axis] of axes) {
    const right = side === "right", tickX = right ? 850 : 110;
    const title = view.axes?.[side]?.label ?? series.filter(item => item.axis === side).map(item => data.columns[item.y]).join(" / ");
    content += `<text transform="translate(${right ? 935 : 25} 210) rotate(${right ? 90 : -90})" text-anchor="middle" font-size="13">${escape(title)}</text>`;
    if (right) content += '<path d="M840 60 V360" stroke="#71717a"/>';
    for (const tick of axis.ticks) content += `<text data-axis="${side}" x="${tickX}" y="${365-axis.position(tick)*300}" text-anchor="${right ? "start" : "end"}" font-size="11">${label(tick, view.axes?.[side])}</text>`;
  }
  for (const tick of x.ticks) {
    const text = numericX ? label(tick, view.axes?.x) : String(data.rows[Math.round(tick)].cells[chart.x]);
    content += `<text data-axis="x" x="${120+x.position(tick)*720}" y="382" text-anchor="middle" font-size="11">${escape(text)}</text>`;
  }
  const refs = chart.dataset ? data.rows.map(row => sourceFor(report.rowSources, row.sourceRows[0])) : [];
  const gaps = data.rows.map((_, i) => {
    const before = refs[i-1], current = refs[i];
    return i === 0 || Boolean(chart.dataset && (!before || !current || before.fileId !== current.fileId || before.sheet !== current.sheet || before.rangeId !== current.rangeId || current.row !== before.row+1));
  });
  const notes: string[] = [];
  series.forEach((item, index) => {
    const y = axes.get(item.axis)!;
    let path = "", isolated = "", outside = 0;
    data.rows.forEach((row, i) => {
      const value = Number(row.cells[item.y]);
      const cx = (120+x.position(xs[i])*720).toFixed(2), cy = (360-y.position(value)*300).toFixed(2);
      path += `${gaps[i] ? "M" : "L"}${cx} ${cy} `;
      if (chart.type === "scatter" || gaps[i] && (i === data.rows.length-1 || gaps[i+1])) isolated += `<circle cx="${cx}" cy="${cy}" r="2" fill="${colors[index]}"/>`;
      if (xs[i] < x.min || xs[i] > x.max || value < y.min || value > y.max) outside++;
    });
    content += `<g clip-path="url(#${clipId})">${chart.type === "scatter" ? "" : `<path data-series="${index}" data-points="${data.rows.length}" d="${path.trim()}" fill="none" stroke="${colors[index]}" stroke-width="1.5"/>`}${isolated}</g>`;
    if (outside) notes.push(`${data.columns[item.y]}: 표시 범위 밖 ${outside}점 (데이터 유지)`);
    content += `<text x="120" y="${425+index*19}" font-size="12" fill="${colors[index]}">${escape(data.columns[item.y])} (${item.axis === "left" ? "왼쪽" : "오른쪽"} 축)</text>`;
  });
  if (chart.type === "scatter" && chart.trendline) {
    const ys = data.rows.map(row => Number(row.cells[chart.y]));
    const magnitudeX = Math.max(1, ...xs.map(Math.abs)), magnitudeY = Math.max(1, ...ys.map(Math.abs));
    const nx = xs.map(v => v / magnitudeX), ny = ys.map(v => v / magnitudeY);
    const mx = nx.reduce((a,b) => a+b, 0)/nx.length, my = ny.reduce((a,b) => a+b, 0)/ny.length;
    const denominator = nx.reduce((sum,v) => sum+(v-mx)**2,0);
    if (denominator > 0) {
      const slope = nx.reduce((sum,v,i) => sum+(v-mx)*(ny[i]-my),0)/denominator;
      const points = [x.min, x.max].map(v => [120+x.position(v)*720,360-axes.get("left")!.position((my+slope*(v/magnitudeX-mx))*magnitudeY)*300]);
      content += `<path clip-path="url(#${clipId})" d="M${points[0].join(" ")} L${points[1].join(" ")}" fill="none" stroke="#dc2626" stroke-dasharray="5 3"/>`;
    }
  }
  for (const annotation of view.annotations ?? []) {
    const item = series[annotation.series], y = axes.get(item.axis)!;
    let peak = -Infinity, selected = -1, ties = 0;
    data.rows.forEach((row, i) => {
      const value = Number(row.cells[item.y]);
      if (annotation.scope === "visibleData" && (xs[i] < x.min || xs[i] > x.max || value < y.min || value > y.max)) return;
      if (value > peak) { peak = value; selected = i; ties = 1; } else if (value === peak) ties++;
    });
    if (selected < 0) { notes.push(`${annotation.label}: 표시 범위에 데이터 없음`); continue; }
    const cx = 120+x.position(xs[selected])*720, cy = 360-y.position(peak)*300;
    const pointLabel = `${annotation.label}: ${numericX ? label(xs[selected], view.axes?.x) : String(data.rows[selected].cells[chart.x])}`;
    const inside = cx >= 120 && cx <= 840 && cy >= 60 && cy <= 360;
    if (inside) content += `<g data-annotation="max" data-x="${xs[selected]}" data-y="${peak}"><path d="M${cx} 360 V${cy}" stroke="${colors[annotation.series]}" stroke-dasharray="4 3"/><circle cx="${cx}" cy="${cy}" r="4" fill="${colors[annotation.series]}"/><text x="${Math.max(220,Math.min(740,cx))}" y="${Math.max(54,cy-12)}" text-anchor="middle" font-size="12">${escape(pointLabel)}</text></g>`;
    notes.push(`${pointLabel}, 최대값 ${label(peak)}${ties > 1 ? ` · 동률 ${ties}점 중 첫 측정점` : ""}${inside ? "" : " · 표시 범위 밖"}`);
  }
  const noteStart = 442 + series.length * 19;
  notes.forEach((note, i) => { content += `<text x="120" y="${noteStart+i*18}" font-size="11">${escape(note)}</text>`; });
  const height = Math.max(440 + series.length * 19, noteStart + notes.length * 18);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 ${height}" role="img" aria-label="${escape(view.title ?? chart.title)}"><rect width="960" height="${height}" fill="white"/><g font-family="sans-serif" fill="#18181b"><text x="120" y="28" font-size="18">${escape(view.title ?? chart.title)}</text>${content}<text x="480" y="405" text-anchor="middle" font-size="13">${escape(view.axes?.x?.label ?? data.columns[chart.x])}</text></g></svg>`;
}
