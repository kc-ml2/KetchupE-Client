import ExcelJS from "exceljs";
import { z } from "zod";
import type { ExtractionPreview, SourceMapping, SourceValueType, WorkbookOverview } from "../../src/app-types/WorkSource.types.ts";

const rowNumber = z.number().int().min(1).max(100000);
export const mappingSchema = z.object({
  sheet: z.string().trim().min(1).max(100), headerRow: rowNumber, firstDataRow: rowNumber,
  lastDataRow: rowNumber.optional(),
  columns: z.array(z.object({ field: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/), header: z.string().trim().min(1).max(200), type: z.enum(["text", "decimal", "date"]), required: z.boolean() }).strict()).min(1).max(50),
  filters: z.array(z.object({ field: z.string(), operator: z.enum(["equals", "notEquals"]), value: z.string().max(500) }).strict()).max(20),
}).strict().superRefine((value, ctx) => {
  if (value.firstDataRow <= value.headerRow || (value.lastDataRow !== undefined && value.lastDataRow < value.firstDataRow)) ctx.addIssue({ code: "custom", message: "데이터 범위는 헤더 다음 행부터 지정해 주세요." });
  const fields = new Set(value.columns.map((column) => column.field));
  if (fields.size !== value.columns.length) ctx.addIssue({ code: "custom", message: "업무 항목 이름이 중복됩니다." });
  if (value.filters.some((filter) => !fields.has(filter.field))) ctx.addIssue({ code: "custom", message: "행 조건의 항목을 먼저 연결해 주세요." });
});

export async function loadWorkbook(bytes: Uint8Array): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(bytes) as unknown as ExcelJS.Buffer);
  if (workbook.worksheets.length > 100 || workbook.worksheets.some((sheet) => sheet.rowCount > 100000 || sheet.columnCount > 500)) throw new Error("파일이 처리 범위를 초과합니다. 시트 100개, 행 100,000개, 열 500개 이하로 나누어 주세요.");
  return workbook;
}

const normalize = (text: string) => text.normalize("NFC").trim();
function cellText(cell: ExcelJS.Cell): string {
  // ExcelJS throws for empty merged cells; merged children are not independent source values.
  if (cell.value == null || (cell.isMerged && cell.master.address !== cell.address)) return "";
  return cell.text;
}
function headers(sheet: ExcelJS.Worksheet, headerRow: number): WorkbookOverview["headers"] {
  return Array.from({ length: sheet.columnCount }, (_, index) => ({ column: index + 1, text: normalize(cellText(sheet.getRow(headerRow).getCell(index + 1))) }));
}

export function inspectWorkbook(workbook: ExcelJS.Workbook, fingerprint: string, sheetName?: string, headerRow = 1): WorkbookOverview {
  rowNumber.parse(headerRow);
  const sheet = sheetName ? workbook.getWorksheet(sheetName) : workbook.worksheets[0];
  if (!sheet) throw new Error("선택한 시트가 없습니다.");
  return {
    fingerprint,
    sheets: workbook.worksheets.map((item) => ({ name: item.name, rowCount: item.rowCount, columnCount: item.columnCount, hidden: item.state !== "visible" })),
    sheet: sheet.name, headers: headers(sheet, headerRow),
    rows: Array.from({ length: Math.min(12, Math.max(0, sheet.rowCount - headerRow + 1)) }, (_, index) => {
      const row = sheet.getRow(headerRow + index);
      return { row: row.number, cells: Array.from({ length: Math.min(30, sheet.columnCount) }, (_, col) => {
        const cell = row.getCell(col + 1);
        return { address: cell.address, text: cellText(cell).slice(0, 300), formula: cell.type === ExcelJS.ValueType.Formula };
      }) };
    }),
  };
}

function convert(value: ExcelJS.CellValue, type: SourceValueType): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "object" && !(value instanceof Date)) {
    if ("richText" in value) return convert(value.richText.map((part) => part.text).join(""), type);
    // Formula caches are not recalculation evidence; do not treat them as verified financial inputs.
    throw new Error("수식·오류·링크 셀입니다. 값으로 확정된 원천 자료를 사용해 주세요.");
  }
  if (type === "date") {
    if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 10);
    const match = String(value).trim().match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (!match) throw new Error("날짜는 YYYY-MM-DD 형식 또는 Excel 날짜 셀이어야 합니다.");
    const iso = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
    const date = new Date(`${iso}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== iso) throw new Error("유효하지 않은 날짜입니다.");
    return iso;
  }
  if (value instanceof Date || typeof value === "boolean") throw new Error("예상한 문자 또는 숫자 형식이 아닙니다.");
  if (type === "text") {
    if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("식별자는 정확한 문자 값 또는 안전한 정수여야 합니다.");
    return normalize(String(value)) || null;
  }
  const text = String(value).trim();
  if (!text) return null;
  if (typeof value === "number" && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) throw new Error("숫자의 정밀도를 확인해 주세요.");
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)) throw new Error("금액 형식이 올바르지 않습니다. 빈 값과 0은 구분합니다.");
  const [whole, fraction = ""] = text.replaceAll(",", "").split(".");
  const integer = BigInt(whole).toString();
  const decimal = fraction.replace(/0+$/, "");
  const sign = text.startsWith("-") && integer === "0" && decimal ? "-" : "";
  return `${sign}${integer}${decimal ? `.${decimal}` : ""}`;
}

export function extractRows(workbook: ExcelJS.Workbook, fingerprint: string, input: SourceMapping): ExtractionPreview {
  const mapping = mappingSchema.parse(input);
  const sheet = workbook.getWorksheet(mapping.sheet);
  if (!sheet) throw new Error("매핑에 지정한 시트가 없습니다. 시트를 다시 선택해 주세요.");
  if (mapping.lastDataRow !== undefined && mapping.lastDataRow > sheet.rowCount) throw new Error("마지막 데이터 행이 시트 범위를 벗어납니다.");
  const header = headers(sheet, mapping.headerRow);
  const columns = mapping.columns.map((column) => {
    const matches = header.filter((item) => item.text === normalize(column.header));
    if (matches.length !== 1) throw new Error(`열 '${column.header}'이 ${matches.length ? "중복됩니다" : "없습니다"}. 헤더 행과 매핑을 확인해 주세요.`);
    if (sheet.getRow(mapping.headerRow).getCell(matches[0].column).type === ExcelJS.ValueType.Formula) throw new Error("헤더의 수식 값을 기준으로 열을 선택할 수 없습니다.");
    return { ...column, index: matches[0].column };
  });
  const filters = mapping.filters.map((filter) => ({ ...filter, value: convert(filter.value, columns.find((column) => column.field === filter.field)!.type) }));
  const result: ExtractionPreview = { fingerprint, scannedRows: 0, matchedRows: 0, excludedRows: 0, blankRows: 0, issueCount: 0, issues: [], rows: [] };
  const issue = (row: number, field: string, message: string) => {
    result.issueCount += 1;
    if (result.issues.length < 100) result.issues.push({ row, field, message });
  };
  for (let rowNumber = mapping.firstDataRow; rowNumber <= Math.min(mapping.lastDataRow ?? sheet.rowCount, sheet.rowCount); rowNumber++) {
    const row = sheet.getRow(rowNumber);
    result.scannedRows += 1;
    if (!row.hasValues) { result.blankRows += 1; continue; }
    const values: Record<string, string | null> = {};
    const cells: Record<string, string> = {};
    let invalid = false;
    // Evaluate filter columns first; an intentionally excluded subtotal must not become a data error.
    const filterFields = new Set(filters.map((filter) => filter.field));
    const read = (column: typeof columns[number]) => {
      const cell = row.getCell(column.index);
      try {
        if (cell.isMerged && cell.master.address !== cell.address) throw new Error("병합 셀의 값은 자동으로 이어 채우지 않습니다.");
        if (column.type === "text" && typeof cell.value === "number" && cell.numFmt && !["General", "0"].includes(cell.numFmt)) throw new Error("숫자 서식이 적용된 식별자입니다. 앞자리 0 등을 보존한 문자 자료로 확인해 주세요.");
        values[column.field] = convert(cell.value, column.type);
        cells[column.field] = cell.address;
      } catch (error) { invalid = true; issue(rowNumber, column.field, error instanceof Error ? error.message : String(error)); }
    };
    columns.filter((column) => filterFields.has(column.field)).forEach(read);
    if (invalid) continue;
    if (filters.some((filter) => filter.operator === "equals" ? values[filter.field] !== filter.value : values[filter.field] === filter.value)) { result.excludedRows += 1; continue; }
    columns.filter((column) => !filterFields.has(column.field)).forEach(read);
    for (const column of columns) if (column.required && values[column.field] === null) { invalid = true; issue(rowNumber, column.field, "필수 값이 비어 있습니다."); }
    if (invalid) continue;
    result.matchedRows += 1;
    if (result.rows.length < 20) result.rows.push({ row: rowNumber, values, cells });
  }
  return result;
}
