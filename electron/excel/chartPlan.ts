import { analysisPlan, chartRequest, type AnalysisPlan, type ChartRequest, type WorkbookProfile } from "./contracts.ts";
import { EXCEL_LIMITS as L, ExcelError } from "./limits.ts";

/** Only JSON constants enter this fixed program; the model never supplies chart code. */
export function compileChart(raw: ChartRequest): AnalysisPlan {
  const plan = chartRequest.parse(raw);
  if ((plan.formats ?? [plan.format]).includes("xlsx")) throw new ExcelError("UNSUPPORTED", "전체 데이터·이중축 차트는 HTML 또는 PDF를 선택해 주세요. XLSX 이중축은 아직 지원하지 않습니다.");
  for (const axis of [plan.x, ...plan.series]) {
    const column = plan.input.columns.find(column => (column.key ?? column.name) === axis.key);
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
  const config = JSON.stringify({ x: plan.x, series: plan.series, title: plan.title });
  const code = `const p = ${config};
const label = c => c.unit && c.label.replace(/\\s/g, '').endsWith('('+c.unit+')') ? c.label : c.label + (c.unit ? ' (' + c.unit + ')' : '');
const rows = [], excluded = [];
const initial = p.series.map(s => input.rows.find(r => typeof r.values[s.key] === 'number')?.values[s.key]);
for (const r of input.rows) {
  const x = r.values[p.x.key], ys = p.series.map(s => r.values[s.key]);
  if (typeof x !== 'number' || ys.some(v => typeof v !== 'number')) { excluded.push({row:r.id,reason:'선택 열의 숫자 데이터 없음'}); continue; }
  rows.push({cells:[x,...ys.map((v,i) => p.series[i].transform === 'loss100' ? 100-v : p.series[i].transform === 'lossInitial' ? initial[i]-v : v)],sourceRows:[r.id]});
}
return {tables:[],datasets:[{title:p.title,columns:[label(p.x),...p.series.map(label)],rows}],excluded,notes:['원본 측정 순서를 유지하며 유효한 전체 데이터를 표시했습니다.'],charts:[{type:'line',table:0,dataset:true,x:0,y:1,xScale:'linear',title:p.title,series:p.series.map((s,i)=>({y:i+1,axis:s.axis}))}]};`;
  return analysisPlan.parse({ kind: "execute", title: plan.title, format: plan.format, formats: plan.formats, layout: plan.layout, steps: plan.steps, assumptions: plan.assumptions, sections: plan.sections, inputs: [plan.input], code, summary: plan.summary ?? "선택한 열의 전체 숫자 데이터를 원본 순서대로 그렸습니다. 축과 단위는 그래프에 표시했습니다." });
}

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
