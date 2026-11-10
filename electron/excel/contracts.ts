import { z } from "zod";
import { EXCEL_LIMITS as L, ExcelError } from "./limits.ts";
import type { RowSources } from "./sources.ts";
import { reportView, type ReportView } from "./viewContracts.ts";

export const outputFormat = z.enum(["pdf", "html", "xlsx", "png", "pptx"]);
export type OutputFormat = z.infer<typeof outputFormat>;
const text = z.string().max(2000);
const rowId = z.number().int().min(1).max(1048576);
export const sheetPlan = z.object({
  fileId: z.string().regex(/^file[1-9][0-9]*$/),
  sheet: z.string().min(1).max(100),
  rangeId: z.string().min(1).max(100).optional(),
  headerRow: z.number().int().min(0).max(1048575),
  headerStartRow: z.number().int().min(1).max(1048575).optional(),
  firstDataRow: rowId.optional(),
  lastDataRow: rowId.optional(),
  allowCellErrors: z.boolean().optional(),
  columns: z.array(z.object({ index: z.number().int().min(1).max(16384), name: z.string().max(100), key: z.string().trim().min(1).max(100).optional() }).strict()).min(1).max(50),
}).strict();
export type SheetPlan = z.infer<typeof sheetPlan>;
export const analysisPlan = z.object({
  kind: z.literal("execute"),
  title: z.string().trim().min(1).max(120),
  format: outputFormat,
  formats: z.array(outputFormat).min(1).max(5).refine(items => new Set(items).size === items.length).optional(),
  view: reportView.optional(),
  layout: z.enum(["report", "dashboard"]).optional(),
  inputs: z.array(sheetPlan).min(1).max(20),
  steps: z.array(text).min(1).max(8),
  assumptions: z.array(text).max(10),
  code: z.string().min(1).max(L.codeChars),
  executionTime: z.number().int().min(0).max(8640000000000000).optional(),
  // Simple requests may finish right after a successful run instead of spending a review turn.
  summary: z.string().min(1).max(12000).optional(),
  sections: z.array(z.object({ title: z.string().max(120), text: z.string().max(6000) }).strict()).max(20).optional(),
}).strict();
const axisColumn = z.object({ key: z.string().min(1).max(100), label: z.string().min(1).max(100), unit: z.string().max(30) }).strict();
export const chartRequest = analysisPlan.omit({ kind: true, code: true, inputs: true }).extend({
  kind: z.literal("chart"), input: sheetPlan,
  x: axisColumn,
  series: z.array(axisColumn.extend({ axis: z.enum(["left", "right"]), transform: z.enum(["identity", "loss100", "lossInitial"]).optional() }).strict()).min(1).max(4),
}).strict();
export type ChartRequest = z.infer<typeof chartRequest>;
const questionOption = z.object({ value: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), label: z.string().min(1).max(500), plan: chartRequest.optional() }).strict();
/** Why the model wants user input; the tool rejects confirmation and re-checks location questions. */
export const askReason = z.enum(["criteria", "candidates", "format", "location", "confirmation"]);
export const profileInspection = z.object({
  sheet: z.string().min(1).max(100),
  startRow: rowId.optional(),
  endRow: rowId.optional(),
  startColumn: z.number().int().min(1).max(16384).optional(),
  endColumn: z.number().int().min(1).max(16384).optional(),
}).strict();
export type ProfileInspection = z.infer<typeof profileInspection>;
export const planResponse = z.discriminatedUnion("kind", [analysisPlan, chartRequest,
  profileInspection.extend({ kind: z.literal("inspect"), fileId: z.string().regex(/^file[1-9][0-9]*$/), query: z.string().max(500) }).strict(),
  z.object({ kind: z.literal("inspect_result"), table: z.number().int().min(0).max(19), startRow: z.number().int().min(1), endRow: z.number().int().min(1) }).strict(),
  z.object({ kind: z.literal("finish"), summary: z.string().min(1).max(12000), sections: z.array(z.object({ title: z.string().max(120), text: z.string().max(6000) }).strict()).max(20).optional() }).strict(),
  z.object({ kind: z.literal("ask"), reason: askReason, question: z.string().min(1).max(2000), options: z.array(questionOption).min(1).max(20).refine(items => new Set(items.map(item => item.value)).size === items.length).optional() }).strict(),
]);
export type AnalysisPlan = z.infer<typeof analysisPlan>;
export type Cell = string | number | null;
export type SourceRef = { fileId: string; sheet: string; row: number; rangeId?: string };
export type SourceFile = { id: string; name: string; fingerprint: string };
export type WorkbookInput = SourceFile & { bytes: Uint8Array };
export type CellMetadata = { display: string; numFmt: string; formula?: string; error?: string; dateTime?: string; dateSerial?: number; fill?: unknown; fontColor?: unknown };
export type InputRow = SourceRef & { id: number; values: Record<string, Cell>; sourceCells?: Record<string, string>; metadata?: Record<string, CellMetadata> };
export type WorkbookProfile = { sheets: { name: string; state: string; rows: number; columns: number; firstColumn: number; metadata: Record<string, CellMetadata>; conditionalFormatting: unknown[]; outline: { entries: { row: number; text: string }[]; nextRow: number | null }; search: { matchedRowCount: number; shownMatchRows: number[]; truncated: boolean; requestedCells: { address: string; row: number; column: number; inBounds: boolean }[]; omittedCellCount: number }; preview: { row: number; cells: Cell[] }[]; mergedCells: Record<string, string>; formulaCells: string[]; issues: { address: string; message: string }[] }[] };

export const chartSpec = z.object({
  type: z.enum(["bar", "line", "scatter", "pie"]), table: z.number().int().min(0).max(19),
  dataset: z.boolean().optional(), x: z.number().int().min(0).max(19), y: z.number().int().min(0).max(19),
  title: z.string().max(120), trendline: z.boolean().optional(), xScale: z.enum(["linear", "category"]).optional(),
  series: z.array(z.object({ y: z.number().int().min(0).max(19), axis: z.enum(["left", "right"]) }).strict()).min(1).max(4).optional(),
}).strict();
export type ChartSpec = z.infer<typeof chartSpec>;
const resultTable = z.object({
  title: z.string().min(1).max(120), columns: z.array(z.string().min(1).max(100)).min(1).max(20),
  rows: z.array(z.object({ cells: z.array(z.union([text, z.number().finite(), z.null()])).max(20), sourceRows: z.array(rowId).min(1).max(L.inputRows) }).strict()).max(L.chartRows),
}).strict();
export const analysisResult = z.object({
  tables: z.array(resultTable).max(20),
  datasets: z.array(resultTable).max(10).optional(),
  excluded: z.array(z.object({ row: rowId, reason: z.string().min(1).max(200) }).strict()).max(L.inputRows),
  notes: z.array(text).max(10), chart: chartSpec.nullable().optional().default(null),
  charts: z.array(chartSpec).max(10).optional(),
}).strict();
export type AnalysisResult = z.infer<typeof analysisResult>;
export type Analysis = { result: AnalysisResult; rowCount: number; blankRows: number; sourceNotes?: string[]; rowSources: RowSources };
export type Report = Analysis & { plan: AnalysisPlan; sources: SourceFile[]; summary: string; sections?: { title: string; text: string }[]; createdAt: string; view?: ReportView };
export const reportCharts = (report: Report) => report.result.charts ?? (report.result.chart ? [report.result.chart] : []);

export const chartTable = (report: Pick<Report, "result">, chart: ChartSpec) => (chart.dataset ? report.result.datasets : report.result.tables)?.[chart.table];
export const chartSeries = (chart: ChartSpec) => chart.series ?? [{ y: chart.y, axis: "left" as const }];
export function assertChartFormat(charts: ChartSpec[], format: OutputFormat) {
  if (format === "xlsx" && charts.some(chart => chart.dataset || chart.series || chart.xScale === "linear" && chart.type === "line"))
    throw new ExcelError("UNSUPPORTED", "숫자형 선 그래프·이중축·전체 데이터 차트는 HTML 또는 PDF로 저장해 주세요. XLSX 이중축은 아직 지원하지 않습니다.");
}

export function parseModelJson(value: string): unknown {
  if (value.length > L.responseChars) throw new Error("모델 응답이 너무 큽니다.");
  return JSON.parse(value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
}

export function validateResult(raw: unknown, rows: InputRow[]): AnalysisResult {
  const result = analysisResult.parse(raw);
  if (!result.tables.length && !result.datasets?.length) throw new Error("표 또는 차트 데이터가 필요합니다.");
  if (result.tables.reduce((n, table) => n + table.rows.length, 0) > L.tableRows) throw new ExcelError("LIMIT", `보고서 표는 ${L.tableRows.toLocaleString("en-US")}행 이하로 집계해 주세요. 전체 그래프에는 chart 계획을 사용하세요.`);
  if ((result.datasets ?? []).reduce((n, table) => n + table.rows.length, 0) > L.chartRows) throw new ExcelError("LIMIT", "차트 데이터 한도를 초과했습니다.");
  if ((result.datasets ?? []).some((_, index) => !(result.charts ?? (result.chart ? [result.chart] : [])).some(chart => chart.dataset && chart.table === index))) throw new Error("차트 데이터에는 연결된 차트가 필요합니다.");
  const available = new Set(rows.map((row) => row.id));
  // Models often confuse the input id with the Excel row number; say exactly which value is wrong so a repair can succeed.
  const unknown = (where: string, id: number) => {
    const sameRow = rows.find((row) => row.row === id);
    return new Error(`${where}의 ${id}는 존재하지 않는 입력 r.id입니다 (r.id는 1~${rows.length}).${sameRow ? ` 엑셀 행 번호 r.row가 아니라 r.id(${sameRow.id} 등)를 사용하세요.` : ""}`);
  };
  const used = new Set<number>();
  for (const table of [...result.tables, ...(result.datasets ?? [])]) for (const row of table.rows) {
    if (row.cells.length !== table.columns.length || new Set(row.sourceRows).size !== row.sourceRows.length) throw new Error("결과 열 또는 원본 행이 중복/누락되었습니다.");
    for (const id of row.sourceRows) {
      if (!available.has(id)) throw unknown(`표 "${table.title}" sourceRows`, id);
      used.add(id);
    }
  }
  const excluded = new Set<number>();
  for (const item of result.excluded) {
    if (!available.has(item.row)) throw unknown("excluded.row", item.row);
    if (used.has(item.row)) throw new Error(`r.id ${item.row}이(가) 결과 sourceRows와 excluded에 동시에 있습니다. 결과에 기여한 행은 excluded에서 빼고, 제외한 행은 sourceRows에서 빼세요.`);
    if (excluded.has(item.row)) throw new Error(`r.id ${item.row}이(가) excluded에 두 번 있습니다. 행마다 제외 이유를 하나만 남기세요.`);
    excluded.add(item.row);
  }
  const missing = [...available].filter((id) => !used.has(id) && !excluded.has(id));
  if (missing.length) throw new Error(`r.id ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? ` 외 ${missing.length - 20}개` : ""} 누락: 결과 sourceRows에도 excluded에도 없습니다. 모든 입력 행을 둘 중 하나에 넣으세요.`);
  if (result.chart && result.charts?.length) throw new Error("chart 또는 charts 중 하나만 사용하세요.");
  for (const chart of result.charts ?? (result.chart ? [result.chart] : [])) {
    const { table: index, x, y } = chart;
    const table = (chart.dataset ? result.datasets : result.tables)?.[index];
    const series = chartSeries(chart), limit = chart.type === "bar" || chart.type === "pie" ? L.categoricalChartRows : L.chartRows;
    if (!table || x >= table.columns.length || !table.rows.length || table.rows.length > limit || series.some(item => item.y === x || item.y >= table.columns.length || table.rows.some(row => typeof row.cells[item.y] !== "number"))) throw new ExcelError("CONTRACT", `차트는 숫자 값이 있는 1~${limit}개 행과 서로 다른 유효한 열이 필요합니다.`);
    if (chart.series && (chart.type !== "line" || new Set(series.map(item => item.y)).size !== series.length)) throw new Error("복수 시리즈는 서로 다른 Y열의 선 그래프에서 지원합니다.");
    if ((chart.type === "scatter" || chart.xScale === "linear") && table.rows.some(row => typeof row.cells[x] !== "number")) throw new Error("산점도의 x값은 숫자여야 합니다.");
    if (chart.type === "pie" && (table.rows.some(row => Number(row.cells[y]) < 0) || !table.rows.some(row => Number(row.cells[y]) > 0))) throw new Error("원형 차트에는 음수 없이 양수 값이 필요합니다.");
    if (chart.trendline && chart.type !== "scatter") throw new Error("회귀선은 산점도에서만 지원합니다.");
  }
  return result;
}
