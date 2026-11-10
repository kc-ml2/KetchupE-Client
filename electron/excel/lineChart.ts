import { chartSeries, chartTable, type ChartSpec, type Report } from "./contracts.ts";
import { sourceFor } from "./sources.ts";

const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const label = (value: number) => Number(value.toPrecision(5)).toString();
function scale(values: number[]) {
  let min = Infinity, max = -Infinity;
  for (const value of values) { min = Math.min(min, value); max = Math.max(max, value); }
  const magnitude = Math.max(Math.abs(min), Math.abs(max), 1);
  const start = min / magnitude, span = (max / magnitude - start) || 1;
  return { min, max, position: (value: number) => min === max ? 0.5 : (value / magnitude - start) / span };
}

/** Paths preserve acquisition order and break at missing source rows; no point decimation. */
export function lineChartSvg(report: Report, chart: ChartSpec): string {
  const data = chartTable(report, chart)!;
  const series = chartSeries(chart), numericX = chart.xScale === "linear";
  const xs = data.rows.map((row, index) => numericX ? Number(row.cells[chart.x]) : index);
  const x = scale(xs), colors = ["#2563eb", "#dc2626", "#16803c", "#9333ea"];
  const axes = new Map<"left" | "right", ReturnType<typeof scale>>();
  for (const side of ["left", "right"] as const) {
    const columns = series.filter(item => item.axis === side);
    if (columns.length) axes.set(side, scale(columns.flatMap(item => data.rows.map(row => Number(row.cells[item.y])))));
  }
  let content = '<path d="M120 60 V360 H840" fill="none" stroke="#71717a"/>';
  for (const [side, axis] of axes) {
    const right = side === "right", tickX = right ? 850 : 110;
    const title = series.filter(item => item.axis === side).map(item => data.columns[item.y]).join(" / ");
    content += `<text transform="translate(${right ? 935 : 25} 210) rotate(${right ? 90 : -90})" text-anchor="middle" font-size="13">${escape(title)}</text>`;
    if (right) content += '<path d="M840 60 V360" stroke="#71717a"/>';
    for (let i = 0; i <= 4; i++) content += `<text x="${tickX}" y="${365-i*75}" text-anchor="${right ? "start" : "end"}" font-size="11">${label(axis.min * (1-i/4) + axis.max * i/4)}</text>`;
  }
  for (let i = 0; i <= 4; i++) {
    const index = Math.round((xs.length - 1) * i/4);
    const text = numericX ? label(x.min * (1-i/4) + x.max * i/4) : String(data.rows[index].cells[chart.x]);
    content += `<text x="${120+i*180}" y="382" text-anchor="middle" font-size="11">${escape(text)}</text>`;
  }
  const refs = chart.dataset ? data.rows.map(row => sourceFor(report.rowSources, row.sourceRows[0])) : [];
  const gaps = data.rows.map((_, i) => {
    const before = refs[i-1], current = refs[i];
    return i === 0 || Boolean(chart.dataset && (!before || !current || before.fileId !== current.fileId || before.sheet !== current.sheet || before.rangeId !== current.rangeId || current.row !== before.row+1));
  });
  series.forEach((item, index) => {
    const y = axes.get(item.axis)!;
    let path = "", isolated = "";
    data.rows.forEach((row, i) => {
      const cx = (120+x.position(xs[i])*720).toFixed(2), cy = (360-y.position(Number(row.cells[item.y]))*300).toFixed(2);
      path += `${gaps[i] ? "M" : "L"}${cx} ${cy} `;
      if (gaps[i] && (i === data.rows.length-1 || gaps[i+1])) isolated += `<circle cx="${cx}" cy="${cy}" r="2" fill="${colors[index]}"/>`;
    });
    content += `<path data-series="${index}" data-points="${data.rows.length}" d="${path.trim()}" fill="none" stroke="${colors[index]}" stroke-width="1.5"/>${isolated}`;
    content += `<text x="120" y="${425+index*19}" font-size="12" fill="${colors[index]}">${escape(data.columns[item.y])} (${item.axis === "left" ? "왼쪽" : "오른쪽"} 축)</text>`;
  });
  const height = 440 + series.length * 19;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 ${height}" role="img" aria-label="${escape(chart.title)}"><rect width="960" height="${height}" fill="white"/><g font-family="sans-serif" fill="#18181b"><text x="120" y="28" font-size="18">${escape(chart.title)}</text>${content}<text x="480" y="405" text-anchor="middle" font-size="13">${escape(data.columns[chart.x])}</text></g></svg>`;
}
