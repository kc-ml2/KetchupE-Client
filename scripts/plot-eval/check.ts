// Scores what KetchupE actually drew (Report → chartOption) against the expectations of the plotkit study sets.
// Engine-neutral on purpose: the checks read the rendered ECharts option and the result tables, not internal keys,
// so the same grader keeps working when the spec layer changes (steps 3–4 of docs/PLOT_SPEC_KEY_MAPPING.md).
import { chartOption } from "../../electron/excel/chart.ts";
import { chartSeries, chartTable, reportCharts, type ChartSpec, type Report } from "../../electron/excel/contracts.ts";

export type CheckResult = { check: string; pass: boolean | null; detail?: string };
type Axis = Record<string, any>;
type Option = ReturnType<typeof chartOption>["option"];

const NAMED: Record<string, string> = { navy: "#000080", black: "#000000", gray: "#808080", grey: "#808080", green: "#008000", red: "#ff0000", orange: "#ffa500" };
const rgb = (c: unknown) => {
  const hex = NAMED[String(c).toLowerCase()] ?? String(c);
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  return m ? [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)) : undefined;
};
/** Same colour family: Euclidean RGB distance ≤ 80 (the model writes hex; plotkit compared exact names). */
export const sameColor = (a: unknown, b: unknown) => { const x = rgb(a), y = rgb(b); return !!x && !!y && Math.hypot(...x.map((v, i) => v - y[i])) <= 80; };
const near = (a: unknown, b: number, tol = 1e-9) => typeof a === "number" && Math.abs(a - b) <= tol;
const letter = (index: number) => { let s = ""; for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; };

type Drawn = { chart: ChartSpec; option: Option; width: number; height: number; sides: ("left" | "right")[] };
const drawn = (report: Report): Drawn[] => reportCharts(report).map(chart => {
  const { option, width, height } = chartOption(report, chart);
  const sides = (["left", "right"] as const).filter(side => chartSeries(chart).some(item => item.axis === side));
  return { chart, option, width, height, sides };
});
const yAxis = (d: Drawn, side: "left" | "right"): Axis | undefined => {
  const index = d.sides.indexOf(side);
  return index < 0 ? undefined : ([d.option.yAxis ?? []].flat() as Axis[])[index];
};
const axisOf = (d: Drawn, name: string): Axis | undefined => name === "x" ? d.option.xAxis as Axis : yAxis(d, name === "y2" ? "right" : "left");
const seriesOn = (d: Drawn, side: "left" | "right") => d.option.series.filter(s => s.type !== "scatter" || d.chart.type === "scatter").filter(s => (s.yAxisIndex ?? 0) === d.sides.indexOf(side) && s.name !== "추세선");
const marks = (d: Drawn, side: "left" | "right", kind: string) => seriesOn(d, side).flatMap(s => ((s.markPoint as any)?.data ?? []).filter((m: any) => m.name === kind));
const markText = (m: any) => String(m.label?.formatter ?? "");
const steps = (axis?: Axis) => {
  const ticks: number[] | undefined = axis?.axisTick?.customValues;
  if (ticks && ticks.length > 1) return ticks.slice(1).map((v, i) => v - ticks[i]);
  return typeof axis?.interval === "number" ? [axis.interval] : [];
};

/** Which source column letters played x / y1 / y2. Exact for compiled chart plans, role-agnostic otherwise. */
function columnRoles(report: Report): Record<string, string> | undefined {
  const config = /^const p = (\{.*\});$/m.exec(report.plan.code)?.[1];
  if (!config) return undefined;
  const p = JSON.parse(config) as { x: { key: string }; series: { key: string; axis: string }[] };
  const columns = report.plan.inputs[0].columns, find = (key: string) => columns.find(c => (c.key ?? c.name) === key)?.index;
  const roles: Record<string, string> = { x: letter(find(p.x.key) ?? 0) };
  const left = p.series.find(s => s.axis === "left"), right = p.series.find(s => s.axis === "right");
  if (left) roles.y1 = letter(find(left.key) ?? 0);
  if (right) roles.y2 = letter(find(right.key) ?? 0);
  return roles;
}

/** One check of tests/expected_requests.json (TGA set A), evaluated on every chart of the report. */
export function checkTga(c: Record<string, any>, report: Report, png?: { width: number; height: number }): CheckResult {
  const charts = drawn(report), name = JSON.stringify(c);
  const all = (fn: (d: Drawn) => boolean | string) => {
    if (!charts.length) return { check: name, pass: false, detail: "차트 없음" };
    for (const d of charts) { const r = fn(d); if (r !== true) return { check: name, pass: false, detail: typeof r === "string" ? r : undefined }; }
    return { check: name, pass: true };
  };
  const sheets = [...new Set(report.plan.inputs.map(input => input.sheet))];
  if ("sheets" in c) return { check: name, pass: JSON.stringify([...sheets].sort()) === JSON.stringify([...c.sheets].sort()), detail: sheets.join(", ") };
  if ("formats" in c) { const got = report.plan.formats ?? [report.plan.format]; return { check: name, pass: c.formats.every((f: string) => got.includes(f as never)), detail: got.join(",") }; }
  if ("columns" in c) {
    const roles = columnRoles(report);
    if (roles) return { check: name, pass: Object.entries(c.columns).every(([role, col]) => roles[role] === col), detail: JSON.stringify(roles) };
    const used = new Set(report.plan.inputs.flatMap(input => input.columns.map(column => letter(column.index))));
    return { check: name, pass: Object.values(c.columns).every(col => used.has(col as string)), detail: `역할 미확인, 사용 열 ${[...used].join(",")}` };
  }
  if ("combined" in c) return { check: name, pass: charts.length === 1 && sheets.length > 1 && charts[0].option.series.length >= sheets.length, detail: `차트 ${charts.length}, 시트 ${sheets.length}` };
  if ("png_px" in c) return { check: name, pass: !!png && png.width === c.png_px[0] && png.height === c.png_px[1], detail: png ? `${png.width}x${png.height}` : "PNG 없음" };
  if ("shade" in c) return all(d => d.option.series.some(s => ((s.markArea as any)?.data ?? []).some((area: any) => near(area[0]?.xAxis, c.shade[0], 1) && near(area[1]?.xAxis, c.shade[1], 1))) || "음영 없음");
  if ("annotation_type" in c) return all(d => d.option.series.some(s => ((s.markLine as any)?.data ?? []).some((line: any) => near(line.xAxis, c.x, 1) && String(line.label?.formatter ?? "").includes(c.text_contains))) || "보조선 없음");
  if ("annotation" in c) {
    // Like plotkit's score.py: present = shown in any plot; other properties are checked on the plots that show it.
    const side = c.annotation === "residue" ? "left" : "right", kinds = c.annotation === "residue" ? ["valueAt"] : ["max", "peak"];
    const marksOf = (d: Drawn) => kinds.flatMap(kind => marks(d, side, kind));
    const shown = charts.filter(d => marksOf(d).length);
    if (c.present === false) return { check: name, pass: !shown.length, ...(shown.length ? { detail: `${shown.length}개 차트에 표시됨` } : {}) };
    if (!shown.length) return { check: name, pass: false, detail: "표시 없음" };
    return all(d => {
      const found = marksOf(d);
      if (!found.length) return true;
      if (c.count !== undefined && found.length !== c.count) return `${found.length}개`;
      if (c.x_used !== undefined && !found.some((m: any) => near(m.coord?.[0], c.x_used, 1))) return `x=${found.map((m: any) => m.coord?.[0]).join(",")}`;
      if (c.text_regex && !found.some((m: any) => new RegExp(c.text_regex).test(markText(m)))) return `글자 "${found.map(markText).join(" | ")}"`;
      return true;
    });
  }
  if ("spec" in c) {
    const [head, ...rest] = String(c.spec).split("."), key = rest.join(".");
    const want = c.eq, color = c.color;
    switch (c.spec) {
      case "preset": return { check: name, pass: null, detail: "케찹이에 프리셋 개념 없음 (채점 제외)" };
      case "annotate.residue.method": return all(d => marks(d, "left", "valueAt").length > 0 || "잔류량 표시 없음"); // KetchupE valueAt is always nearest
      case "annotate.residue.text": return { check: name, pass: null, detail: "text_regex 검사로 대체" };
      case "annotate.residue.x": return all(d => marks(d, "left", "valueAt").some((m: any) => near(m.coord?.[0], want, 1)) || "해당 x 표시 없음");
      case "annotate.peak.count": return all(d => marks(d, "right", "max").length === want || `${marks(d, "right", "max").length}개`);
      case "title.text": return all(d => (d.option.title as any)?.text === want || `"${(d.option.title as any)?.text}"`);
      case "title.size": return all(d => (d.option.title as any)?.textStyle?.fontSize === want || `${(d.option.title as any)?.textStyle?.fontSize}`);
      case "title.color": return all(d => sameColor((d.option.title as any)?.textStyle?.color, color) || `${(d.option.title as any)?.textStyle?.color}`);
      case "legend.show": return all(d => Boolean(d.option.legend) === want || `범례 ${d.option.legend ? "있음" : "없음"}`);
      case "legend.where": return all(d => { const l = d.option.legend as any; return !!l && (want.includes("right") ? l.right !== undefined || l.left === "right" : true) && (want.includes("upper") ? (l.top ?? 999) < d.height / 2 : true) || `top=${l?.top}, left=${l?.left}`; });
      case "legend.size": return all(d => (d.option.legend as any)?.textStyle?.fontSize === want || `${(d.option.legend as any)?.textStyle?.fontSize}`);
      case "grid": return all(d => [d.option.xAxis, ...[d.option.yAxis ?? []].flat()].some((a: any) => a?.splitLine?.show) === want || "격자 불일치");
      case "tick_direction": return all(d => [d.option.xAxis, ...[d.option.yAxis ?? []].flat()].every((a: any) => Boolean(a?.axisTick?.inside) === (want === "in")) || "틱 방향 불일치");
      case "size": return all(d => (d.width === want[0] * 96 && d.height === want[1] * 96) || `${d.width}x${d.height}px`);
      case "dpi": return { check: name, pass: false, detail: "dpi 설정 없음" };
      case "text_color": return all(d => sameColor((d.option.textStyle as any)?.color, color) || `${(d.option.textStyle as any)?.color}`);
      case "font_size": return all(d => (d.option.textStyle as any)?.fontSize === want || `${(d.option.textStyle as any)?.fontSize}`);
    }
    // <axis>.<key>
    return all(d => {
      const axis = axisOf(d, head), series = head === "x" ? [] : seriesOn(d, head === "y2" ? "right" : "left");
      switch (key) {
        case "show": return Boolean(axis) === want || `축 ${axis ? "있음" : "없음"}`;
        case "min": case "max": return near(axis?.[key], want, 1e-9) || `${axis?.[key]}`;
        case "step": { const s = steps(axis); return (s.length > 0 && s.every(v => near(v, want, 1e-6))) || `간격 ${s.join(",") || "자동"}`; }
        case "label": return axis?.name === want || `"${axis?.name}"`;
        case "tick_size": return axis?.axisLabel?.fontSize === want || `${axis?.axisLabel?.fontSize}`;
        case "label_color": return sameColor(axis?.nameTextStyle?.color, color) || `${axis?.nameTextStyle?.color}`;
        case "color": return (series.length > 0 && series.every(s => sameColor((s.lineStyle as any)?.color ?? (s.itemStyle as any)?.color, color))) || `${series.map(s => (s.lineStyle as any)?.color).join(",")}`;
        case "width": return (series.length > 0 && series.every(s => (s.lineStyle as any)?.width === want)) || `${series.map(s => (s.lineStyle as any)?.width).join(",")}`;
        case "linestyle": return (series.length > 0 && series.every(s => ((s.lineStyle as any)?.type ?? "solid") === want)) || `${series.map(s => (s.lineStyle as any)?.type ?? "solid").join(",")}`;
      }
      return `검사 미구현: ${c.spec}`;
    });
  }
  return { check: name, pass: null, detail: "알 수 없는 검사" };
}

// ---------------------------------------------------------------- CNT (value-based) expectations

const label = (v: unknown) => {
  const text = String(v ?? "").trim();
  // A month written as 2026-03 is the same category as the study's month number 3 (its data spans one year).
  if (/^\d{4}-\d{2}$/.test(text)) return String(Number(text.slice(5)));
  const nums = text.match(/-?\d+(?:\.\d+)?/g);
  // Bin labels such as "2.5–3" vs "2.5-3.0" compare by their numbers; plain categories by text.
  return nums && /[–\-~]/.test(text.replace(/^-/, "")) ? nums.map(Number).join("|") : /^-?\d+(\.0+)?$/.test(text) ? String(Number(text)) : text;
};
const aggTol = (v: number) => Math.max(Math.abs(v) * 0.005, 0.01);
const rangeTol = (v: number) => Math.max(Math.abs(v) * 0.005, 0.05);
const close = (got: unknown, want: number, tol: number) => typeof got === "number" && Number.isFinite(got) && Math.abs(got - want) <= tol;
const pearson = (xs: number[], ys: number[]) => {
  const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return sxy / Math.sqrt(sxx * syy);
};
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : undefined;

export function kindOf(chart: ChartSpec) {
  if (chart.type === "bar") {
    const n = chartSeries(chart).length;
    if (n > 1) return chart.stack ? "stacked_bar" : "grouped_bar";
    return chart.horizontal ? "hbar" : "bar";
  }
  return chart.type === "area" ? "line" : chart.type;
}

/** Match expected series names to drawn columns by content ("R1" ⊂ "R1 평균 수율"); one-to-one when only one each. */
function matchSeries(expected: string[], columns: string[]) {
  if (expected.length === 1 && columns.length === 1) return new Map([[expected[0], columns[0]]]);
  const map = new Map<string, string>();
  for (const name of expected) {
    const hit = columns.find(c => c === name) ?? columns.find(c => c.includes(name) || name.includes(c));
    if (hit) map.set(name, hit);
  }
  return map;
}

/** One turn's `expect` of the CNT study (experiments/eval/cnt/dev/requests.json). */
export function checkCnt(expect: Record<string, any>, report: Report): CheckResult[] {
  const out: CheckResult[] = [], add = (check: string, pass: boolean | null, detail?: string) => out.push({ check, pass, detail });
  const chart = reportCharts(report)[0];
  if (!chart) return [{ check: "chart", pass: false, detail: "차트 없음" }];
  const table = chartTable(report, chart)!, kind = kindOf(chart), v = expect.values ?? {}, data = expect.data ?? {};
  add("kind", kind === expect.kind, `${kind} (기대 ${expect.kind})`);
  const counts = data.agg === "count" || data.agg === undefined && ["pie", "bar", "stacked_bar", "grouped_bar"].includes(expect.kind) && !data.y;
  const valueTol = (w: number) => counts && Number.isInteger(w) ? 0 : aggTol(w);
  const xs = table.rows.map(row => row.cells[chart.x]);

  if (["bar", "hbar", "pie"].includes(expect.kind) && v.values) {
    const got = new Map(table.rows.map(row => [label(row.cells[chart.x]), num(row.cells[chart.y])]));
    const want = Object.entries(v.values as Record<string, number>);
    const missing = want.filter(([k]) => !got.has(label(k)));
    add("categories", !missing.length && got.size === want.length, missing.length ? `없음: ${missing.map(([k]) => k).join(",")}` : `${got.size}개`);
    const wrong = want.filter(([k, w]) => got.has(label(k)) && !close(got.get(label(k)), w, valueTol(w)));
    add("values", !missing.length && !wrong.length, wrong.slice(0, 3).map(([k, w]) => `${k}: ${got.get(label(k))} ≠ ${w}`).join("; "));
    if (data.sort && v.order) add("order", JSON.stringify(xs.map(label)) === JSON.stringify((v.order as string[]).map(label)), xs.slice(0, 5).join(","));
  }
  if (["grouped_bar", "stacked_bar"].includes(expect.kind) && v.values) {
    const series = chartSeries(chart), columns = series.map(s => table.columns[s.y]);
    const map = matchSeries(v.series ?? [], columns);
    add("series", map.size === (v.series ?? []).length && columns.length === (v.series ?? []).length, `열 ${columns.join(",")}`);
    let bad = "";
    for (const [x, inner] of Object.entries(v.values as Record<string, Record<string, number>>)) {
      const row = table.rows.find(r => label(r.cells[chart.x]) === label(x));
      for (const [s, w] of Object.entries(inner)) {
        const col = map.get(s), got = row && col ? num(row.cells[table.columns.indexOf(col)]) ?? (w === 0 ? 0 : undefined) : undefined;
        if (!close(got, w, valueTol(w)) && !bad) bad = `${x}/${s}: ${got} ≠ ${w}`;
      }
    }
    add("values", !bad, bad);
  }
  if (expect.kind === "line" && v.series) {
    const series = chartSeries(chart), columns = series.map(s => table.columns[s.y]);
    const want = Object.entries(v.series as Record<string, { n: number; x_range: (number | string)[]; y_range: number[]; points?: [number, number][] }>);
    const map = matchSeries(want.map(([k]) => k), columns);
    add("n_series", columns.length === Number(v.n_series) && map.size === want.length, `열 ${columns.join(",")}`);
    let bad = "";
    for (const [name, s] of want) {
      const col = map.get(name); if (!col) continue;
      const y = table.columns.indexOf(col), pts = table.rows.map(r => [num(r.cells[chart.x]), num(r.cells[y])] as const).filter(([a, b]) => a !== undefined && b !== undefined) as [number, number][];
      if (pts.length !== s.n) { bad ||= `${name}: n ${pts.length} ≠ ${s.n}`; continue; }
      const ys = pts.map(p => p[1]);
      if (!close(Math.min(...ys), s.y_range[0], rangeTol(s.y_range[0])) || !close(Math.max(...ys), s.y_range[1], rangeTol(s.y_range[1]))) bad ||= `${name}: y범위 ${Math.min(...ys)}~${Math.max(...ys)}`;
      for (const [px, py] of s.points ?? []) { const hit = pts.find(p => near(p[0], px, 1e-6)); if (!hit || !close(hit[1], py, aggTol(py))) { bad ||= `${name}: x=${px} ${hit?.[1]} ≠ ${py}`; break; } }
    }
    add("values", !bad && map.size === want.length, bad);
  }
  if (expect.kind === "scatter") {
    const series = chartSeries(chart);
    const pts = series.flatMap(s => table.rows.map(r => [num(r.cells[chart.x]), num(r.cells[s.y])] as const)).filter(([a, b]) => a !== undefined && b !== undefined) as [number, number][];
    add("n", pts.length === Number(v.n), `${pts.length}`);
    const xr = v.x_range as number[], yr = v.y_range as number[];
    const xs2 = pts.map(p => p[0]), ys2 = pts.map(p => p[1]);
    add("ranges", pts.length > 0 && close(Math.min(...xs2), xr[0], rangeTol(xr[0])) && close(Math.max(...xs2), xr[1], rangeTol(xr[1])) && close(Math.min(...ys2), yr[0], rangeTol(yr[0])) && close(Math.max(...ys2), yr[1], rangeTol(yr[1])));
    if (v.pearson_r !== undefined && pts.length > 2) add("pearson_r", close(pearson(xs2, ys2), Number(v.pearson_r), 0.01), pearson(xs2, ys2).toFixed(3));
    if (v.series) add("series", series.length === Object.keys(v.series).length, `시리즈 ${series.length}`);
  }
  if (expect.kind === "histogram") {
    const values = table.rows.map(r => num(r.cells[chart.y])).filter((x): x is number => x !== undefined);
    add("n", values.length === Number(v.n), `${values.length}`);
    if (v.bins?.edges) {
      // Edges as chart.ts draws them: equal width between min and max.
      const low = Math.min(...values), high = Math.max(...values), bins = chart.bins ?? Math.max(5, Math.min(50, Math.ceil(Math.log2(values.length)) + 1));
      const edges = chart.edges ?? Array.from({ length: bins + 1 }, (_, i) => low + i * (high - low) / bins), want = v.bins.edges as number[];
      add("bins", edges.length === want.length && edges.every((e, i) => near(e, want[i], 1e-6)), `${edges.length - 1}구간 ${edges[0]}~${edges.at(-1)}`);
    }
  }
  if (expect.kind === "heatmap" && v.matrix) {
    const rowsWant = (v.rows as unknown[]).map(label), colsWant = (v.cols as unknown[]).map(label);
    const cell = new Map<string, number | undefined>();
    for (const r of table.rows) cell.set(`${label(r.cells[chart.y])}\u0000${label(r.cells[chart.x])}`, num(r.cells[chart.value ?? -1]));
    const rowsGot = new Set(table.rows.map(r => label(r.cells[chart.y]))), colsGot = new Set(table.rows.map(r => label(r.cells[chart.x])));
    add("axes", rowsWant.every(r => rowsGot.has(r)) && colsWant.every(c => colsGot.has(c)) && rowsGot.size === rowsWant.length && colsGot.size === colsWant.length, `행 ${rowsGot.size}, 열 ${colsGot.size}`);
    let bad = "";
    (v.matrix as number[][]).forEach((row, i) => row.forEach((w, j) => { const got = cell.get(`${rowsWant[i]}\u0000${colsWant[j]}`) ?? (w === 0 ? 0 : undefined); if (!close(got, w, valueTol(w)) && !bad) bad = `${rowsWant[i]}/${colsWant[j]}: ${got} ≠ ${w}`; }));
    add("matrix", !bad, bad);
  }
  // Display asks that have a drawn counterpart; the rest are listed as unchecked.
  const view = report.view?.charts["0"] ?? {}, { option } = chartOption(report, chart);
  for (const ask of expect.asks ?? []) {
    if (ask.what === "title") add("ask:title", ((option.title as any)?.text ?? "") === ask.value, (option.title as any)?.text);
    else if (ask.what === "ylim") add("ask:ylim", near(view.axes?.left?.min, ask.value[0]) && near(view.axes?.left?.max, ask.value[1]), JSON.stringify(view.axes?.left));
    else if (ask.what === "xtick_step") add("ask:xtick_step", near(view.axes?.x?.tickStep, ask.value), JSON.stringify(view.axes?.x));
    else if (ask.what === "value_labels" || ask.what === "pct_labels") add(`ask:${ask.what}`, chart.type === "pie" || view.labels === true);
    else add(`ask:${ask.what}`, null, "채점 미구현");
  }
  return out;
}
