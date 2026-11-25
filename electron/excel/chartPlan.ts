import { analysisPlan, chartRequest, chartSeries, type AnalysisPlan, type ChartRequest, type ChartSpec, type WorkbookProfile } from "./contracts.ts";
import { EXCEL_LIMITS as L, ExcelError } from "./limits.ts";
import type { PlanPatch } from "./revision.ts";

const FILTER = /^\s*[`'"]?(.+?)[`'"]?\s*(not in|>=|<=|==|!=|=|>|<|\bin\b|\bbetween\b|\bcontains\b)\s*(.+?)\s*$/i;
/** "반응기 == R3" → the column it names and the rest; shared with resolveInputs, which adds that column to the input. */
export const splitFilter = (text: string) => { const m = FILTER.exec(text); return m ? { column: m[1].trim(), op: m[2].toLowerCase() === "=" ? "==" : m[2].toLowerCase(), value: m[3].trim() } : undefined; };
const literal = (text: string): string | number => { const t = text.trim().replace(/^[`'"]|[`'"]$/g, ""); return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : t; };

/** A revision's compute patch over the stored chart plan: null removes a key, x merges field by field, series replaces. */
export function mergeChartRequest(current: ChartRequest, patch: PlanPatch): Record<string, unknown> {
  const next: Record<string, unknown> = structuredClone(current);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || key === "x") continue;
    if (value === null) delete next[key]; else next[key] = value;
  }
  if (patch.x) {
    const x: Record<string, unknown> = { ...current.x };
    // A different x column needs its own label and unit (resolveInputs fills them from the header).
    if (patch.x.key && patch.x.key !== current.x.key) { delete x.label; delete x.unit; }
    for (const [key, value] of Object.entries(patch.x)) { if (value === null) delete x[key]; else if (value !== undefined) x[key] = value; }
    next.x = x;
  }
  return next;
}

/** Only JSON constants enter these fixed programs; the model never supplies chart code. */
export function compileChart(raw: ChartRequest): AnalysisPlan {
  const plan = chartRequest.parse(raw);
  const type = plan.chartType ?? "line";
  const legacy = ["line", "area", "scatter"].includes(type) && !plan.agg && !plan.by && !plan.filter && !plan.sort && !plan.top && !plan.movingAverage && !plan.x.period && !plan.x.bins;
  const columnOf = (key: string) => plan.input.columns.find(column => (column.key ?? column.name) === key);
  for (const axis of [plan.x, ...plan.series]) {
    const column = columnOf(axis.key);
    if (!column) throw new ExcelError("CONTRACT", `선택한 열에 ${axis.key}가 없습니다.`);
    const unit = column.name.match(/[（(]([^()（）]+)[）)]\s*$/)?.[1].replace(/\s/g, "");
    if (unit && unit !== axis.unit.replace(/\s/g, "")) throw new ExcelError("CONTRACT", `열 ${column.index}의 원본 단위는 ${unit}입니다. 단위나 변환 기준을 확인해 주세요.`);
  }
  for (const side of ["left", "right"] as const) {
    if (new Set(plan.series.filter(series => series.axis === side).map(series => series.unit)).size > 1)
      throw new ExcelError("CONTRACT", "서로 다른 단위의 시리즈는 별도 Y축을 사용해 주세요.");
  }
  if (plan.series.some(series => series.transform && series.transform !== "identity" && series.unit !== "%"))
    throw new ExcelError("CONTRACT", "Weight Loss 변환은 원본 백분율 값에만 적용합니다.");
  const notApplied = [...(plan.notApplied ?? [])];
  let formats = plan.formats ?? [plan.format];
  const summary = plan.summary ?? "선택한 열의 전체 숫자 데이터를 원본 순서대로 분석했습니다. 축과 단위는 그래프에 표시했습니다.";
  if (legacy) {
    if (formats.includes("xlsx")) throw new ExcelError("UNSUPPORTED", "전체 데이터·이중축 차트는 HTML 또는 PDF를 선택해 주세요. XLSX 이중축은 아직 지원하지 않습니다.");
    if (plan.series.length < 1) throw new ExcelError("CONTRACT", "그릴 Y열(series)을 하나 이상 지정하세요.");
    if (plan.stack && plan.chartType !== "area" || plan.smooth && plan.chartType === "scatter") throw new ExcelError("CONTRACT", "stack은 영역, smooth는 선·영역 그래프에서 지원합니다.");
    // Kept byte-for-byte: stored checkpoints replay this exact program and compare result hashes.
    const options = { ...(type === "scatter" ? {} : { xScale: "linear" }), ...(plan.smooth ? { smooth: true } : {}), ...(plan.stack ? { stack: true } : {}) };
    const config = JSON.stringify({ x: plan.x, series: plan.series, title: plan.title, type, options });
    const code = `const p = ${config};
const label = c => c.unit && c.label.replace(/\\s/g, '').endsWith('('+c.unit+')') ? c.label : c.label + (c.unit ? ' (' + c.unit + ')' : '');
const rows = [], excluded = [];
const initial = p.series.map(s => input.rows.find(r => typeof r.values[s.key] === 'number')?.values[s.key]);
for (const r of input.rows) {
  const x = r.values[p.x.key], ys = p.series.map(s => r.values[s.key]);
  if (typeof x !== 'number' || ys.some(v => typeof v !== 'number')) { excluded.push({row:r.id,reason:'선택 열의 숫자 데이터 없음'}); continue; }
  rows.push({cells:[x,...ys.map((v,i) => p.series[i].transform === 'loss100' ? 100-v : p.series[i].transform === 'lossInitial' ? initial[i]-v : v)],sourceRows:[r.id]});
}
return {tables:[],datasets:[{title:p.title,columns:[label(p.x),...p.series.map(label)],rows}],excluded,notes:['원본 측정 순서를 유지하며 유효한 전체 데이터를 표시했습니다.'],charts:[{type:p.type,table:0,dataset:true,x:0,y:1,...p.options,title:p.title,series:p.series.map((s,i)=>({y:i+1,axis:s.axis}))}]};`;
    return analysisPlan.parse({ kind: "execute", title: plan.title, format: plan.format, formats: plan.formats, view: plan.view, layout: plan.layout, steps: plan.steps, assumptions: plan.assumptions, sections: plan.sections, notApplied: plan.notApplied, inputs: [plan.input], code, summary });
  }

  // Grouped mode: one row per category (x [, by]) with sourceRows = every contributing input row.
  const distribution = type === "histogram" || type === "boxplot";
  const grouped = !distribution && Boolean(plan.agg || plan.x.period || plan.x.bins || ["bar", "hbar", "pie", "heatmap"].includes(type));
  const agg = plan.agg ?? (grouped && !plan.series.length ? "count" : grouped ? "mean" : undefined);
  if (!plan.series.length && agg !== "count" && type !== "histogram") throw new ExcelError("CONTRACT", "값 열(series)을 지정하거나 agg:\"count\"로 건수를 세세요.");
  if (distribution && plan.agg) throw new ExcelError("CONTRACT", "히스토그램·박스플롯은 집계 없이 원자료를 그립니다(histogram: x = 분포를 볼 숫자 열, boxplot: x = 범주, series[0] = 숫자 열).");
  if (type === "boxplot" && !plan.series.length) throw new ExcelError("CONTRACT", "박스플롯은 series[0]에 숫자 열이 필요합니다.");
  if (type === "pie" && (plan.by || plan.series.length > 1)) throw new ExcelError("CONTRACT", "원형 차트는 값 열 하나(또는 건수)만 그립니다. 범주별로 나누려면 막대(by)를 쓰세요.");
  if (type === "heatmap" && !plan.by) throw new ExcelError("CONTRACT", "히트맵은 x(열 범주)와 by(행 범주)가 필요합니다.");
  if (plan.by && plan.series.length > 1) throw new ExcelError("CONTRACT", "by로 나눌 때 값 열(series)은 하나만 지정하세요.");
  if (plan.by && !columnOf(plan.by.key)) throw new ExcelError("CONTRACT", `선택한 열에 by 열 ${plan.by.key}가 없습니다. input.columns에 추가하세요.`);
  if (plan.stack && !["bar", "hbar", "area"].includes(type) || plan.smooth && !["line", "area"].includes(type)) throw new ExcelError("CONTRACT", "stack은 막대·영역, smooth는 선·영역 그래프에서 지원합니다.");
  if (plan.movingAverage && !["line", "area"].includes(type)) throw new ExcelError("CONTRACT", "이동평균(movingAverage)은 선·영역 그래프에서 지원합니다.");
  const filters = (plan.filter ?? []).map(text => {
    const part = splitFilter(text);
    if (!part) throw new ExcelError("CONTRACT", `필터 "${text}"를 해석하지 못했습니다. "열 == 값", "열 >= 10", "열 in [A, B]", "열 between A and B", "열 contains 글자" 형태로 쓰세요.`);
    const column = plan.input.columns.find(c => c.key === part.column || c.name === part.column);
    if (!column) throw new ExcelError("CONTRACT", `필터 열 ${part.column}이 선택한 열에 없습니다. input.columns에 추가하세요.`);
    const value = part.op === "in" || part.op === "not in" ? part.value.replace(/^\[|\]$/g, "").split(",").map(literal)
      : part.op === "between" ? part.value.split(/\s+and\s+|\s*~\s*/i).map(literal)
      : literal(part.value);
    if (part.op === "between" && (value as unknown[]).length !== 2) throw new ExcelError("CONTRACT", `between 필터는 "열 between A and B" 형태로 두 값을 쓰세요: ${text}`);
    return { key: column.key ?? column.name, op: part.op, value, text };
  });
  const native = grouped && plan.series.length <= 1 && !plan.by && ["bar", "hbar", "line", "area", "pie"].includes(type);
  if (formats.includes("xlsx") && !native) {
    formats = formats.filter(f => f !== "xlsx");
    if (!formats.length) formats = ["html"];
    notApplied.push("XLSX 편집형 차트는 이 차트 구성(원자료·복수 시리즈·범주 분할·히트맵 등)을 지원하지 않아 HTML로 만들었습니다.");
  }
  const config = JSON.stringify({
    title: plan.title, type, grouped, agg: agg ?? null, x: plan.x, series: plan.series, by: plan.by ?? null, filters,
    sort: plan.sort ?? null, top: plan.top ?? null, ma: plan.movingAverage ?? null, smooth: Boolean(plan.smooth), stack: Boolean(plan.stack),
    categoricalLimit: L.categoricalChartRows,
  });
  const code = `const p = ${config};
${PROGRAM}`;
  if (code.length > L.codeChars) throw new ExcelError("LIMIT", "차트 설정이 너무 큽니다. 필터·정렬 목록을 줄여 주세요.");
  return analysisPlan.parse({ kind: "execute", title: plan.title, format: formats[0], formats: formats.length > 1 ? formats : undefined, view: plan.view, layout: plan.layout, steps: plan.steps, assumptions: plan.assumptions, sections: plan.sections, notApplied: notApplied.length ? notApplied.slice(0, 10) : undefined, inputs: [plan.input], code, summary: plan.summary ?? "요청한 기준으로 선택한 열을 집계해 그래프로 나타냈습니다. 적용 기준은 표 위 메모에 있습니다." });
}

/** The fixed program for grouped and filtered charts. Runs in the QuickJS sandbox with `p` (JSON) and `input`. */
const PROGRAM = String.raw`const isNum = v => typeof v === 'number' && isFinite(v);
const label = c => c.unit && c.label.replace(/\s/g, '').endsWith('('+c.unit+')') ? c.label : c.label + (c.unit ? ' (' + c.unit + ')' : '');
const natural = (a, b) => { if (isNum(a) && isNum(b)) return a - b; const x = String(a), y = String(b); const nx = Number(x), ny = Number(y); if (x !== '' && y !== '' && isFinite(nx) && isFinite(ny)) return nx - ny; return x < y ? -1 : x > y ? 1 : 0; };
const same = (v, w) => v === w || String(v) === String(w);
const pass = (v, f) => {
  if (f.op === 'contains') return v !== null && v !== undefined && String(v).includes(String(f.value));
  if (f.op === 'in' || f.op === 'not in') { const hit = f.value.some(w => same(v, w)); return f.op === 'in' ? hit : !hit; }
  if (v === null || v === undefined || v === '') return f.op === '!=';
  if (f.op === '==') return same(v, f.value);
  if (f.op === '!=') return !same(v, f.value);
  if (f.op === 'between') return natural(v, f.value[0]) >= 0 && natural(v, f.value[1]) <= 0;
  const c = natural(v, f.value);
  return f.op === '>' ? c > 0 : f.op === '>=' ? c >= 0 : f.op === '<' ? c < 0 : c <= 0;
};
const fmt = v => String(Number(v.toPrecision(6)));
const excluded = [], kept = [];
for (const r of input.rows) {
  const bad = p.filters.find(f => !pass(r.values[f.key], f));
  if (bad) excluded.push({ row: r.id, reason: ('필터 제외: ' + bad.text).slice(0, 200) }); else kept.push(r);
}
const initial = p.series.map(s => { const r = kept.find(r => isNum(r.values[s.key])); return r ? r.values[s.key] : null; });
const yval = (r, i) => { const v = r.values[p.series[i].key], t = p.series[i].transform; if (!isNum(v)) return null; return t === 'loss100' ? 100 - v : t === 'lossInitial' ? initial[i] - v : v; };
let edges = null;
if (p.x.bins) {
  const xs = kept.map(r => r.values[p.x.key]).filter(isNum);
  if (Array.isArray(p.x.bins.edges)) edges = p.x.bins.edges;
  else if (xs.length) {
    const lo = p.x.bins.min !== undefined ? p.x.bins.min : Math.min(...xs), hi = p.x.bins.max !== undefined ? p.x.bins.max : Math.max(...xs);
    if (typeof p.x.bins === 'number') edges = Array.from({ length: p.x.bins + 1 }, (_, i) => lo + (hi - lo) * i / p.x.bins);
    else { const w = p.x.bins.width, start = p.x.bins.min !== undefined ? lo : Math.floor(lo / w) * w; edges = []; for (let e = start; e < hi + w * 1e-9 || edges.length < 2; e += w) { edges.push(Number(e.toPrecision(12))); if (edges.length > 101) break; } if (edges[edges.length - 1] < hi) edges.push(Number((edges[edges.length - 1] + w).toPrecision(12))); }
  }
}
const pad = n => String(n).padStart(2, '0');
const xcat = r => {
  const v = r.values[p.x.key];
  if (v === null || v === undefined || v === '') return null;
  if (p.x.period) {
    const d = String(v).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
    const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7));
    if (p.x.period === 'day') return { label: d, order: d };
    if (p.x.period === 'month') return { label: d.slice(0, 7), order: d.slice(0, 7) };
    if (p.x.period === 'year') return { label: String(y), order: y };
    if (p.x.period === 'quarter') { const q = y + '-Q' + (Math.floor((m - 1) / 3) + 1); return { label: q, order: q }; }
    const t = Date.UTC(y, m - 1, Number(d.slice(8, 10))), dow = (new Date(t).getUTCDay() + 6) % 7, monday = new Date(t - dow * 86400000);
    const w = monday.getUTCFullYear() + '-' + pad(monday.getUTCMonth() + 1) + '-' + pad(monday.getUTCDate());
    return { label: w + ' 주', order: w };
  }
  if (edges) {
    if (!isNum(v) || v < edges[0] || v > edges[edges.length - 1]) return null;
    let i = 0; while (i < edges.length - 2 && v >= edges[i + 1]) i++;
    return { label: fmt(edges[i]) + '–' + fmt(edges[i + 1]), order: i };
  }
  return { label: v, order: v };
};
const notes = [];
if (p.filters.length) notes.push('필터: ' + p.filters.map(f => f.text).join(', '));
const columnsOf = () => p.series.map(label);
let table, chart;
const reduce = (vals, n) => {
  if (p.agg === 'count') return n;
  const xs = vals.filter(isNum);
  if (!xs.length) return null;
  if (p.agg === 'sum') return xs.reduce((a, b) => a + b, 0);
  if (p.agg === 'min') return Math.min(...xs);
  if (p.agg === 'max') return Math.max(...xs);
  if (p.agg === 'first') return xs[0];
  if (p.agg === 'last') return xs[xs.length - 1];
  if (p.agg === 'nunique') return new Set(xs).size;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (p.agg === 'std') return xs.length > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (xs.length - 1)) : 0;
  if (p.agg === 'median') { const s = xs.slice().sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
  return mean;
};
const AGG = { mean: '평균', sum: '합계', count: '건수', median: '중앙값', min: '최솟값', max: '최댓값', std: '표준편차', first: '첫 값', last: '마지막 값', nunique: '고유 개수' };
if (p.grouped) {
  const groups = new Map(), byValues = [];
  for (const r of kept) {
    const x = xcat(r);
    if (!x) { excluded.push({ row: r.id, reason: 'X 범주 값 없음 또는 구간 밖' }); continue; }
    let b = null;
    if (p.by) { b = r.values[p.by.key]; if (b === null || b === undefined || b === '') { excluded.push({ row: r.id, reason: '분할 열 값 없음' }); continue; } }
    const ys = p.series.map((_, i) => yval(r, i));
    if (p.agg !== 'count' && ys.every(v => v === null)) { excluded.push({ row: r.id, reason: '값 열의 숫자 데이터 없음' }); continue; }
    const key = JSON.stringify([x.label, b]);
    if (!groups.has(key)) groups.set(key, { x: x.label, order: x.order, b, ids: [], vals: p.series.map(() => []) });
    const g = groups.get(key); g.ids.push(r.id); ys.forEach((v, i) => g.vals[i].push(v));
    if (p.by && !byValues.some(w => same(w, b))) byValues.push(b);
  }
  byValues.sort(natural);
  const xOrder = new Map();
  for (const g of groups.values()) if (!xOrder.has(JSON.stringify(g.x))) xOrder.set(JSON.stringify(g.x), g.order);
  let xs = [...xOrder.keys()].map(k => JSON.parse(k)).sort((a, b) => natural(xOrder.get(JSON.stringify(a)), xOrder.get(JSON.stringify(b))));
  const fill = p.agg === 'count' || p.agg === 'sum' ? 0 : null;
  const valueName = p.series.length ? label(p.series[0]) : '건수';
  notes.push('집계: ' + AGG[p.agg] + (p.by ? ', ' + (p.by.label || p.by.key) + '별 분할' : ''));
  if (p.type === 'heatmap') {
    const rows = [...groups.values()].sort((a, b) => natural(a.order, b.order) || natural(a.b, b.b)).map(g => ({ cells: [g.x, g.b, reduce(g.vals[0] || [], g.ids.length)], sourceRows: g.ids }));
    for (const r of rows.filter(r => r.cells[2] === null)) for (const id of r.sourceRows) excluded.push({ row: id, reason: '값 열의 숫자 데이터 없음' });
    table = { title: p.title, columns: [label(p.x), p.by.label || p.by.key, (p.series.length ? AGG[p.agg] + ' ' : '') + valueName], rows: rows.filter(r => r.cells[2] !== null) };
    chart = { type: 'heatmap', table: 0, x: 0, y: 1, value: 2, title: p.title };
  } else {
    const rowFor = x => {
      const parts = [...groups.values()].filter(g => same(g.x, x));
      const ids = parts.flatMap(g => g.ids);
      const cells = p.by ? byValues.map(b => { const g = parts.find(g => same(g.b, b)); return g ? reduce(g.vals[0] || [], g.ids.length) : fill; })
        : p.series.length ? p.series.map((_, i) => reduce(parts[0].vals[i], parts[0].ids.length)) : [parts[0].ids.length];
      return { x, cells, ids };
    };
    let rows = xs.map(rowFor);
    const total = r => r.cells.reduce((a, v) => a + (isNum(v) ? v : 0), 0);
    if (Array.isArray(p.sort)) { const at = x => { const i = p.sort.findIndex(w => same(w, x)); return i < 0 ? p.sort.length : i; }; rows.sort((a, b) => at(a.x) - at(b.x) || natural(a.x, b.x)); }
    else if (p.sort === 'desc' || p.sort === 'asc') rows.sort((a, b) => (p.sort === 'desc' ? -1 : 1) * (total(a) - total(b)));
    if (p.top && rows.length > p.top) {
      const cut = rows.slice(p.top);
      rows = rows.slice(0, p.top);
      if (p.type === 'pie' && (p.agg === 'count' || p.agg === 'sum')) rows.push({ x: '기타', cells: [cut.reduce((a, r) => a + total(r), 0)], ids: cut.flatMap(r => r.ids) });
      else for (const r of cut) for (const id of r.ids) excluded.push({ row: id, reason: '상위 ' + p.top + '개 밖' });
      notes.push('상위 ' + p.top + '개만 표시');
    }
    const valueColumns = p.by ? byValues.map(String) : p.series.length ? columnsOf() : ['건수'];
    if (p.ma) {
      const w = p.ma.window, avg = (col, i) => { if (i + 1 < w) return null; const xs = rows.slice(i + 1 - w, i + 1).map(r => r.cells[col]); return xs.every(isNum) ? xs.reduce((a, b) => a + b, 0) / w : null; };
      const extra = rows.map((_, i) => valueColumns.map((__, c) => avg(c, i)));
      rows.forEach((r, i) => { r.cells = p.ma.keepRaw ? r.cells.concat(extra[i]) : extra[i]; });
      if (p.ma.keepRaw) valueColumns.push(...valueColumns.map(c => c + ' ' + w + '구간 이동평균')); else valueColumns.forEach((c, i) => { valueColumns[i] = c + ' ' + w + '구간 이동평균'; });
      notes.push(w + '구간 이동평균 (뒤쪽 창, 앞쪽 ' + (w - 1) + '개 구간은 값 없음)');
    }
    const emptyRows = rows.filter(r => r.cells.every(v => v === null));
    for (const r of emptyRows) for (const id of r.ids) excluded.push({ row: id, reason: '값 열의 숫자 데이터 없음' });
    rows = rows.filter(r => !r.cells.every(v => v === null));
    if ((p.type === 'bar' || p.type === 'hbar' || p.type === 'pie') && rows.length > p.categoricalLimit) throw new Error('범주가 ' + rows.length + '개로 막대·원형 한도 ' + p.categoricalLimit + '개를 넘습니다. top이나 bins로 줄이세요.');
    table = { title: p.title, columns: [p.x.period ? label(p.x) + ' (' + { day: '일', week: '주', month: '월', quarter: '분기', year: '연' }[p.x.period] + ')' : label(p.x), ...valueColumns], rows: rows.map(r => ({ cells: [r.x, ...r.cells], sourceRows: r.ids })) };
    const numericX = rows.every(r => isNum(r.x)) && !edges && !p.x.period;
    const type = p.type === 'hbar' ? 'bar' : p.type;
    const many = valueColumns.length > 1;
    chart = { type, table: 0, x: 0, y: 1, title: p.title };
    if (many) chart.series = valueColumns.map((_, i) => ({ y: i + 1, axis: p.by ? 'left' : (p.series[i] ? p.series[i].axis : 'left') }));
    if (p.type === 'hbar') chart.horizontal = true;
    if (p.stack) chart.stack = true;
    if (p.smooth) chart.smooth = true;
    if ((type === 'line' || type === 'area') && numericX) chart.xScale = 'linear';
  }
  return { tables: [table], datasets: [], excluded, notes, charts: [chart] };
}
// Raw mode: every measured row in source order (filters, by-split, moving average and distributions).
const rows = [];
if (p.type === 'histogram' || p.type === 'boxplot') {
  for (const r of kept) {
    const v = p.type === 'histogram' ? (isNum(r.values[p.x.key]) ? r.values[p.x.key] : null) : yval(r, 0), x = p.type === 'boxplot' ? r.values[p.x.key] : null;
    if (v === null || (p.type === 'boxplot' && (x === null || x === undefined || x === ''))) { excluded.push({ row: r.id, reason: '선택 열의 숫자 데이터 없음' }); continue; }
    rows.push({ cells: p.type === 'boxplot' ? [x, v] : [v], sourceRows: [r.id] });
  }
  const columns = p.type === 'boxplot' ? [label(p.x), label(p.series[0])] : [label(p.x)];
  chart = p.type === 'boxplot' ? { type: 'boxplot', table: 0, dataset: true, x: 0, y: 1, title: p.title } : { type: 'histogram', table: 0, dataset: true, x: 0, y: 0, title: p.title };
  if (p.type === 'histogram' && edges) chart.edges = edges;
  else if (p.type === 'histogram' && typeof p.x.bins === 'number') chart.bins = p.x.bins;
  return { tables: [], datasets: [{ title: p.title, columns, rows }], excluded, notes: notes.concat(['원본 측정값을 행마다 하나씩 사용했습니다.']), charts: [chart] };
}
const byValues = [];
for (const r of kept) { if (!p.by) break; const b = r.values[p.by.key]; if (b !== null && b !== undefined && b !== '' && !byValues.some(w => same(w, b))) byValues.push(b); }
byValues.sort(natural);
for (const r of kept) {
  const x = r.values[p.x.key];
  const ys = p.series.map((_, i) => yval(r, i));
  const b = p.by ? r.values[p.by.key] : null;
  if (x === null || x === undefined || x === '' || ys.every(v => v === null) || (p.by && (b === null || b === undefined || b === ''))) { excluded.push({ row: r.id, reason: '선택 열의 데이터 없음' }); continue; }
  rows.push({ cells: [x, ...(p.by ? byValues.map(w => same(w, b) ? ys[0] : null) : ys)], sourceRows: [r.id] });
}
const valueColumns = p.by ? byValues.map(String) : columnsOf();
if (p.ma) {
  const w = p.ma.window, n = valueColumns.length;
  const extra = rows.map((_, i) => valueColumns.map((__, c) => { if (i + 1 < w) return null; const xs = rows.slice(i + 1 - w, i + 1).map(r => r.cells[c + 1]); return xs.every(isNum) ? xs.reduce((a, b) => a + b, 0) / w : null; }));
  rows.forEach((r, i) => { r.cells = p.ma.keepRaw ? r.cells.concat(extra[i]) : [r.cells[0]].concat(extra[i]); });
  const names = valueColumns.map(c => c + ' ' + w + '점 이동평균');
  if (p.ma.keepRaw) valueColumns.push(...names); else valueColumns.splice(0, n, ...names);
  notes.push(w + '점 이동평균 (뒤쪽 창)');
}
const numericX = rows.every(r => isNum(r.cells[0]));
const chartType = p.type === 'hbar' ? 'bar' : p.type;
chart = { type: chartType, table: 0, dataset: true, x: 0, y: 1, title: p.title, series: valueColumns.map((_, i) => ({ y: i + 1, axis: p.by ? 'left' : (p.series[i] ? p.series[i].axis : p.series[i - p.series.length] ? p.series[i - p.series.length].axis : 'left') })) };
if (numericX && chartType !== 'scatter') chart.xScale = 'linear';
if (p.smooth) chart.smooth = true;
if (p.stack) chart.stack = true;
return { tables: [], datasets: [{ title: p.title, columns: [label(p.x), ...valueColumns], rows }], excluded, notes: notes.concat(['원본 측정 순서를 유지했습니다.']), charts: [chart] };`;

export function preflight(plan: AnalysisPlan, profiles: { fileId: string; sheets: Pick<WorkbookProfile["sheets"][number], "name" | "rows" | "columns">[] }[]) {
  let count = 0;
  for (const input of plan.inputs) {
    const sheet = profiles.find(file => file.fileId === input.fileId)?.sheets.find(sheet => sheet.name === input.sheet);
    if (!sheet) throw new ExcelError("CONTRACT", "분석 계획이 선택하지 않은 파일 또는 시트를 참조합니다.");
    const first = input.firstDataRow ?? input.headerRow + 1, last = input.lastDataRow ?? sheet.rows;
    if (first <= input.headerRow || last < first || last > sheet.rows || input.columns.some(column => column.index > sheet.columns)) throw new ExcelError("CONTRACT", "분석 계획의 행·열 범위가 원본과 맞지 않습니다.");
    const length = last - first + 1;
    if (length > L.inputRows) throw new ExcelError("LIMIT", `선택 범위는 최대 ${L.inputRows.toLocaleString("en-US")}행입니다. 필요한 온도·측정 구간을 지정해 주세요.`);
    count += length;
  }
  // This is a conservative upper bound: blank rows may reduce the actual extracted count.
  if (count > L.inputRows) throw new ExcelError("LIMIT", `선택 범위 합계가 ${L.inputRows.toLocaleString("en-US")}행을 넘습니다. 분석 범위를 줄여 주세요.`);
}

const TGA_X = /온도|temp/i, TGA_WEIGHT = /weight|중량|무게|질량|mass/i, TGA_DTG = /deriv|dtg|미분|변화율/i;
/**
 * The plotkit TGA preset: a temperature–weight chart with a derivative curve on the right gets the residue at 800 °C
 * (only when the run reaches it) and the highest DTG peak above 150 °C, unless the request already set annotations.
 */
export function tgaAnnotations(request: ChartRequest, chart: ChartSpec, table: { rows: { cells: unknown[] }[] }) {
  if (request.chartType && request.chartType !== "line" || !(TGA_X.test(request.x.label ?? "") || /°C/.test(request.x.unit ?? ""))) return undefined;
  const weight = request.series.findIndex(s => s.axis === "left" && (TGA_WEIGHT.test(s.label ?? "") || s.unit === "%"));
  const dtg = request.series.findIndex(s => s.axis === "right" && (TGA_DTG.test(s.label ?? "") || (s.unit ?? "").includes("/")));
  if (weight < 0 && dtg < 0 || chartSeries(chart).length !== request.series.length) return undefined;
  const col = (row: { cells: unknown[] }, i: number) => row.cells[i], xi = chart.x;
  const xs = table.rows.map(r => col(r, xi)).filter((v): v is number => typeof v === "number");
  const out = [];
  if (weight >= 0 && Math.min(...xs) <= 800 && Math.max(...xs) >= 800)
    out.push({ series: weight, kind: "valueAt" as const, x: 800, label: "Residue", format: `Residue {y:.1f}${request.series[weight].unit || "%"}` });
  if (dtg >= 0) {
    const ys = table.rows.filter(r => { const x = col(r, xi); return typeof x === "number" && x >= 150; }).map(r => col(r, chartSeries(chart)[dtg]?.y ?? -1)).filter((v): v is number => typeof v === "number");
    if (ys.length) out.push({ series: dtg, kind: "peak" as const, count: 1, xMin: 150, direction: -Math.min(...ys) > Math.max(...ys) ? "down" as const : "up" as const, label: "DTG 피크", format: "{x:.0f} °C" });
  }
  return out.length ? out : undefined;
}
