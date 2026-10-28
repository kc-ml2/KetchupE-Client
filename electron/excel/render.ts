import ExcelJS from "exceljs";
import { createHash } from "node:crypto";
import { reportCharts } from "./contracts.ts";
import { addNativeCharts } from "./xlsxCharts.ts";
import type { ChartSpec, Report } from "./contracts.ts";

const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const provenance = (report: Report) => report.sources.map(source => `[${source.id}] ${source.name} · SHA-256 ${source.fingerprint}`).join("\n");
const counts = (report: Report) => `대상 ${report.rowCount}행 · 분석 포함 ${report.rowCount - report.result.excluded.length}행 · 제외 ${report.result.excluded.length}행 · 빈 행 ${report.blankRows}개`;

export function sourceRowsText(rows: number[]): string {
  const sorted = [...rows].sort((a, b) => a - b);
  const ranges: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i]; let end = start;
    while (i + 1 < sorted.length && sorted[i + 1] === end + 1) end = sorted[++i];
    ranges.push(start === end ? String(start) : `${start}-${end}`);
  }
  return ranges.join(", ");
}

export function evidenceText(report: Report, ids: number[]): string {
  const groups = new Map<string, number[]>();
  for (const id of ids) {
    const ref = report.rowSources[id];
    if (!ref) throw new Error(`원본 근거가 없는 입력 행입니다: ${id}`);
    const file = report.sources.find(source => source.id === ref.fileId);
    if (!file) throw new Error(`원본 파일을 찾을 수 없습니다: ${ref.fileId}`);
    const label = `[${file.id}] ${file.name} / ${ref.sheet}`;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(ref.row);
  }
  return [...groups].map(([label, rows]) => `${label}: ${sourceRowsText(rows)}행`).join("; ");
}

export function chartSvg(report: Report, chart: ChartSpec | undefined = reportCharts(report)[0]): string {
  if (!chart) return "";
  const table = report.result.tables[chart.table];
  const values = table.rows.map(row => row.cells[chart.y] as number);
  const palette = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#d97706", "#0891b2"];
  let marks = "";
  if (chart.type === "pie") {
    const scale = Math.max(...values), total = values.reduce((sum, v) => sum + v / scale, 0);
    let angle = -Math.PI / 2;
    marks = values.map((v, i) => {
      const fraction = (v / scale) / total, end = angle + fraction * Math.PI * 2;
      const arc = fraction >= 1 ? `<circle cx="220" cy="165" r="100" fill="${palette[i % palette.length]}"/>` : `<path d="M220 165 L${220 + Math.cos(angle) * 100} ${165 + Math.sin(angle) * 100} A100 100 0 ${fraction > .5 ? 1 : 0} 1 ${220 + Math.cos(end) * 100} ${165 + Math.sin(end) * 100} Z" fill="${palette[i % palette.length]}"/>`;
      angle = end;
      return arc + (i < 12 ? `<text x="350" y="${55 + i * 20}" font-size="12" fill="${palette[i % palette.length]}">${escape(table.rows[i].cells[chart.x])}: ${escape(v)}</text>` : "");
    }).join("");
  } else {
    const lo = Math.min(0, ...values), hi = Math.max(0, ...values);
    const magnitude = Math.max(Math.abs(lo), Math.abs(hi), 1), bottom = lo / magnitude, span = hi / magnitude - bottom || 1;
    const y = (v: number) => 260 - (v / magnitude - bottom) / span * 200;
    const xs = table.rows.map((row, i) => chart.type === "scatter" ? Number(row.cells[chart.x]) : i);
    const xScale = Math.max(1, ...xs.map(Math.abs)), xMin = Math.min(...xs) / xScale, xSpan = Math.max(...xs) / xScale - xMin || 1;
    const x = (i: number) => chart.type === "bar" ? 80 + (i + .5) * 640 / values.length : 80 + (xs[i] / xScale - xMin) / xSpan * 640;
    marks = values.map((v, i) => chart.type === "bar"
      ? `<rect x="${x(i) - 160 / values.length}" y="${Math.min(y(0), y(v))}" width="${320 / values.length}" height="${Math.max(1, Math.abs(y(v) - y(0)))}" fill="#2563eb"/>`
      : `<circle cx="${x(i)}" cy="${y(v)}" r="3" fill="#2563eb"/>`).join("");
    if (chart.type === "line") marks += `<polyline fill="none" stroke="#2563eb" stroke-width="2" points="${values.map((v, i) => `${x(i)},${y(v)}`).join(" ")}"/>`;
    if (chart.type === "scatter" && chart.trendline && xs.length > 1) {
      const nx = xs.map(v => v / xScale), ny = values.map(v => v / magnitude);
      const mx = nx.reduce((a,b)=>a+b,0)/nx.length, my = ny.reduce((a,b)=>a+b,0)/ny.length;
      const denominator = nx.reduce((sum,v)=>sum+(v-mx)**2,0);
      if (denominator > 0) {
        const slope = nx.reduce((sum,v,i)=>sum+(v-mx)*(ny[i]-my),0)/denominator;
        const ends = [Math.min(...nx), Math.max(...nx)].map(v => [80+(v-xMin)/xSpan*640, 260-((my+slope*(v-mx))-bottom)/span*200]);
        if (ends.flat().every(Number.isFinite)) marks += `<path d="M${ends[0].join(" ")} L${ends[1].join(" ")}" stroke="#dc2626" stroke-dasharray="5 3"/>`;
      }
    }
    marks += `<text x="8" y="65" font-size="11">${escape(hi)}</text><text x="8" y="260" font-size="11">${escape(lo)}</text><path d="M80 ${y(0)} H720" stroke="#a1a1aa"/>`;
    marks += table.rows.filter((_,i)=>i % Math.max(1,Math.ceil(table.rows.length/12))===0).map(row => { const i=table.rows.indexOf(row); return `<text x="${x(i)}" y="285" text-anchor="middle" font-size="10">${escape(String(row.cells[chart.x] ?? "").slice(0,12))}</text>`; }).join("");
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 320" role="img" aria-label="${escape(chart.title)}"><rect width="800" height="320" fill="white"/><g font-family="sans-serif" fill="#18181b"><text x="24" y="25" font-size="16">${escape(chart.title)}</text>${marks}<text x="24" y="310" font-size="11">${escape(table.columns[chart.y])} / ${escape(table.columns[chart.x])}</text></g></svg>`;
}

const FILTER_SCRIPT = 'document.querySelectorAll("[data-filter]").forEach(input=>input.addEventListener("input",()=>{const q=input.value.toLocaleLowerCase();input.closest("section").querySelectorAll("tbody tr").forEach(row=>{row.hidden=!row.textContent.toLocaleLowerCase().includes(q);});}));';
const SCRIPT_HASH = createHash("sha256").update(FILTER_SCRIPT).digest("base64");
export function validReportHtml(html: string) {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  return html.startsWith("<!doctype html>") && html.includes("default-src 'none'") && (scripts.length === 0 || (scripts.length === 1 && scripts[0][1] === FILTER_SCRIPT && html.includes(`script-src 'sha256-${SCRIPT_HASH}'`)));
}

export function renderHtml(report: Report, interactive = true): string {
  const filtering = interactive && report.plan.layout === "dashboard";
  const list = (items: string[]) => `<ul>${items.map((s) => `<li>${escape(s)}</li>`).join("")}</ul>`;
  const tables = report.result.tables.map((table) => `<section><h2>${escape(table.title)}</h2>${filtering ? `<label>표 검색 <input data-filter aria-label="${escape(table.title)} 검색" type="search"></label>` : ""}<table><thead><tr>${[...table.columns, "원본 행"].map((c) => `<th>${escape(c)}</th>`).join("")}</tr></thead><tbody>${table.rows.map((row) => `<tr>${row.cells.map((c) => `<td>${escape(c)}</td>`).join("")}<td>${escape(evidenceText(report, row.sourceRows))}</td></tr>`).join("")}</tbody></table>${!table.rows.length ? "<p>조건에 해당하는 결과가 없습니다.</p>" : ""}</section>`).join("");
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; ${filtering ? `script-src 'sha256-${SCRIPT_HASH}'` : `script-src 'none'`}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(report.plan.title)}</title><style>body{font-family:Arial,'Malgun Gothic','Apple SD Gothic Neo',sans-serif;color:#18181b;max-width:1100px;margin:32px auto;padding:0 24px;font-size:13px;line-height:1.6}h1{font-size:26px}h2{font-size:18px;margin-top:28px}p,li,td,th{overflow-wrap:anywhere}table{width:100%;table-layout:fixed;border-collapse:collapse;margin:12px 0}th,td{border:1px solid #d4d4d8;padding:7px;text-align:left;vertical-align:top}th{background:#f4f4f5}th:last-child,td:last-child{width:35%}thead{display:table-header-group}svg{width:100%;max-height:400px}pre{white-space:pre-wrap;font-family:inherit}.source{white-space:pre-wrap;font-size:10px;color:#52525b}@page{size:A4;margin:14mm}@media print{body{margin:0;padding:0}svg{break-inside:avoid}h2{break-after:avoid}tr{break-inside:avoid}input,label{display:none}}.charts{display:grid;grid-template-columns:${report.plan.layout === "dashboard" ? "repeat(auto-fit,minmax(320px,1fr))" : "1fr"};gap:16px}section{margin-bottom:24px}@media print{.charts{grid-template-columns:1fr}svg{max-height:260px}}</style></head><body><h1>${escape(report.plan.title)}</h1><p>${escape(counts(report))}</p><p class="source">${escape(provenance(report))}<br>${escape(report.createdAt)}</p>${report.plan.assumptions.length ? `<h2>적용 기준</h2>${list(report.plan.assumptions)}` : ""}<h2>요약</h2><pre>${escape(report.summary)}</pre>${(report.sections ?? []).map(section=>`<h2>${escape(section.title)}</h2><pre>${escape(section.text)}</pre>`).join("")}<div class="charts">${reportCharts(report).map(chart=>chartSvg(report,chart)).join("")}</div>${tables}<h2>참고 사항</h2>${list([...(report.sourceNotes ?? []), ...report.result.notes, "LLM이 생성한 분석입니다. 업무에 사용하기 전 집계 기준과 수치를 확인해 주세요."])}${report.result.excluded.length ? `<h2>제외 행</h2>${list(report.result.excluded.map((r) => `${evidenceText(report, [r.row])}: ${r.reason}`))}` : ""}${filtering ? `<script>${FILTER_SCRIPT}</script>` : ""}</body></html>`;
}

export async function renderXlsx(report: Report): Promise<Uint8Array> {
  const book = new ExcelJS.Workbook();
  const info = book.addWorksheet("분석 안내");
  info.addRows([[report.plan.title], [provenance(report)], [report.createdAt], [counts(report)], ["적용 기준"], ...report.plan.assumptions.map((s) => [s]), ["요약"], [report.summary], ...[...(report.sourceNotes ?? []), ...report.result.notes].map((s) => [s]), ["LLM 생성 분석: 업무에 사용하기 전 수치를 확인해 주세요."]]);
  for (const section of report.sections ?? []) info.addRows([[section.title], [section.text]]);
  info.getColumn(1).width = 100;
  for (const [index, table] of report.result.tables.entries()) {
    const sheet = book.addWorksheet(`결과 ${index + 1}`);
    sheet.addRow([table.title]);
    sheet.addRow([...table.columns, "원본 행"]);
    for (const row of table.rows) sheet.addRow([...row.cells, evidenceText(report, row.sourceRows)]);
    sheet.getRow(2).font = { bold: true };
    sheet.columns.forEach((column) => { column.width = 24; });
    sheet.getColumn(table.columns.length + 1).width = 60;
    sheet.views = [{ state: "frozen", ySplit: 2 }];
  }
  const excluded = book.addWorksheet("제외 행");
  excluded.addRows([["원본 행", "제외 이유"], ...report.result.excluded.map((row) => [evidenceText(report, [row.row]), row.reason])]);
  excluded.getColumn(2).width = 60;
  for (const [index] of reportCharts(report).entries()) book.addWorksheet(`차트 ${index + 1}`, {
    pageSetup: { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 1, printArea: "A1:M21" },
  });
  for (const sheet of book.worksheets) sheet.eachRow((row) => row.eachCell((cell) => { cell.alignment = { vertical: "top", wrapText: true }; }));
  return addNativeCharts(new Uint8Array(await book.xlsx.writeBuffer()), report);
}

export function reportPreview(report: Report): string {
  const safe = (v: unknown) => typeof v === "number" ? String(v) : String(v ?? "").replace(/[\\`*_{}[\]()<>#+.!|~-]/g, "\\$&").replace(/[\r\n]+/g, " ");
  const table = report.result.tables[0];
  const rows = table.rows.slice(0, 12);
  return `${report.plan.title}\n\n${counts(report)}\n\n${(report.sourceNotes ?? []).map(safe).join("\n\n")}\n\n${report.summary}\n\n| ${table.columns.map(safe).join(" | ")} |\n| ${table.columns.map(() => "---").join(" | ")} |\n${rows.map((r) => `| ${r.cells.map(safe).join(" | ")} |`).join("\n")}\n\n첫 표 ${rows.length}/${table.rows.length}행 미리보기입니다. 전체 표·차트·원본 행 근거는 결과 파일에서 확인하세요.\n\nLLM 생성 분석이므로 업무 사용 전 수치를 확인해 주세요.`;
}
