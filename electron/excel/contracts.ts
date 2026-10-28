import { z } from "zod";

export const outputFormat = z.enum(["pdf", "html", "xlsx"]);
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
  formats: z.array(outputFormat).min(1).max(3).refine(items => new Set(items).size === items.length).optional(),
  layout: z.enum(["report", "dashboard"]).optional(),
  inputs: z.array(sheetPlan).min(1).max(20),
  steps: z.array(text).min(1).max(8),
  assumptions: z.array(text).max(10),
  code: z.string().min(1).max(30000),
  // Simple requests may finish right after a successful run instead of spending a review turn.
  summary: z.string().min(1).max(12000).optional(),
  sections: z.array(z.object({ title: z.string().max(120), text: z.string().max(6000) }).strict()).max(20).optional(),
}).strict();
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
export const planResponse = z.discriminatedUnion("kind", [analysisPlan,
  profileInspection.extend({ kind: z.literal("inspect"), fileId: z.string().regex(/^file[1-9][0-9]*$/), query: z.string().max(500) }).strict(),
  z.object({ kind: z.literal("inspect_result"), table: z.number().int().min(0).max(19), startRow: z.number().int().min(1), endRow: z.number().int().min(1) }).strict(),
  z.object({ kind: z.literal("finish"), summary: z.string().min(1).max(12000), sections: z.array(z.object({ title: z.string().max(120), text: z.string().max(6000) }).strict()).max(20).optional() }).strict(),
  z.object({ kind: z.literal("ask"), reason: askReason, question: z.string().min(1).max(2000) }).strict(),
]);
export type AnalysisPlan = z.infer<typeof analysisPlan>;
export type Cell = string | number | null;
export type SourceRef = { fileId: string; sheet: string; row: number; rangeId?: string };
export type SourceFile = { id: string; name: string; fingerprint: string };
export type WorkbookInput = SourceFile & { bytes: Uint8Array };
export type CellMetadata = { display: string; numFmt: string; formula?: string; error?: string; dateTime?: string; dateSerial?: number; fill?: unknown; fontColor?: unknown };
export type InputRow = SourceRef & { id: number; values: Record<string, Cell>; sourceCells?: Record<string, string>; metadata?: Record<string, CellMetadata> };
export type WorkbookProfile = { sheets: { name: string; state: string; rows: number; columns: number; firstColumn: number; metadata: Record<string, CellMetadata>; conditionalFormatting: unknown[]; outline: { entries: { row: number; text: string }[]; nextRow: number | null }; search: { matchedRowCount: number; shownMatchRows: number[]; truncated: boolean; requestedCells: { address: string; row: number; column: number; inBounds: boolean }[]; omittedCellCount: number }; preview: { row: number; cells: Cell[] }[]; mergedCells: Record<string, string>; formulaCells: string[]; issues: { address: string; message: string }[] }[] };

export const chartSpec = z.object({ type: z.enum(["bar", "line", "scatter", "pie"]), table: z.number().int().min(0).max(19), x: z.number().int().min(0).max(19), y: z.number().int().min(0).max(19), title: z.string().max(120), trendline: z.boolean().optional() }).strict();
export type ChartSpec = z.infer<typeof chartSpec>;
export const analysisResult = z.object({
  tables: z.array(z.object({
    title: z.string().min(1).max(120),
    columns: z.array(z.string().min(1).max(100)).min(1).max(20),
    rows: z.array(z.object({ cells: z.array(z.union([text, z.number().finite(), z.null()])).max(20), sourceRows: z.array(rowId).min(1).max(10000) }).strict()).max(5000),
  }).strict()).min(1).max(20),
  excluded: z.array(z.object({ row: rowId, reason: z.string().min(1).max(200) }).strict()).max(10000),
  notes: z.array(text).max(10),
  chart: chartSpec.nullable(),
  charts: z.array(chartSpec).max(10).optional(),
}).strict();
export type AnalysisResult = z.infer<typeof analysisResult>;
export type Analysis = { result: AnalysisResult; rowCount: number; blankRows: number; sourceNotes?: string[]; rowSources: Record<number, SourceRef> };
export type Report = Analysis & { plan: AnalysisPlan; sources: SourceFile[]; summary: string; sections?: { title: string; text: string }[]; createdAt: string };
export const reportCharts = (report: Report) => report.result.charts ?? (report.result.chart ? [report.result.chart] : []);

export function parseModelJson(value: string): unknown {
  if (value.length > 60000) throw new Error("모델 응답이 너무 큽니다.");
  return JSON.parse(value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
}

export function validateResult(raw: unknown, rows: InputRow[]): AnalysisResult {
  const result = analysisResult.parse(raw);
  if (result.tables.reduce((n, table) => n + table.rows.length, 0) > 5000) throw new Error("결과는 5,000행 이하로 집계해 주세요.");
  const available = new Set(rows.map((row) => row.id));
  const used = new Set<number>();
  for (const table of result.tables) for (const row of table.rows) {
    if (row.cells.length !== table.columns.length || new Set(row.sourceRows).size !== row.sourceRows.length) throw new Error("결과 열 또는 원본 행이 중복/누락되었습니다.");
    for (const id of row.sourceRows) {
      if (!available.has(id)) throw new Error("존재하지 않는 원본 행을 참조했습니다.");
      used.add(id);
    }
  }
  const excluded = new Set<number>();
  for (const item of result.excluded) {
    if (!available.has(item.row) || used.has(item.row) || excluded.has(item.row)) throw new Error("제외 행이 원본 또는 분석 대상과 일치하지 않습니다.");
    excluded.add(item.row);
  }
  if (used.size + excluded.size !== available.size) throw new Error("분석에서 누락한 행의 제외 이유가 필요합니다.");
  if (result.chart && result.charts?.length) throw new Error("chart 또는 charts 중 하나만 사용하세요.");
  for (const chart of result.charts ?? (result.chart ? [result.chart] : [])) {
    const { table: index, x, y } = chart;
    const table = result.tables[index];
    if (!table || x === y || x >= table.columns.length || y >= table.columns.length || !table.rows.length || table.rows.length > 500 || table.rows.some((row) => typeof row.cells[y] !== "number")) throw new Error("차트는 숫자 값이 있는 1~500개 행과 서로 다른 유효한 두 열이 필요합니다.");
    if (chart.type === "scatter" && table.rows.some(row => typeof row.cells[x] !== "number")) throw new Error("산점도의 x값은 숫자여야 합니다.");
    if (chart.type === "pie" && (table.rows.some(row => Number(row.cells[y]) < 0) || !table.rows.some(row => Number(row.cells[y]) > 0))) throw new Error("원형 차트에는 음수 없이 양수 값이 필요합니다.");
    if (chart.trendline && chart.type !== "scatter") throw new Error("회귀선은 산점도에서만 지원합니다.");
  }
  return result;
}
