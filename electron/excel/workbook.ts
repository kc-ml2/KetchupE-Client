import ExcelJS from "exceljs";
import JSZip from "jszip";
import { format } from "ssf";
import { DOMParser } from "@xmldom/xmldom";
import { posix } from "node:path";
import { createHash } from "node:crypto";
import { loadWorkbook } from "../work/mapping.ts";
import { profileInspection } from "./contracts.ts";
import type { AnalysisPlan, Cell, CellMetadata, InputRow, ProfileInspection, SheetPlan, WorkbookInput, WorkbookProfile } from "./contracts.ts";

// ponytail: last 3 parsed workbooks per worker process; inspect/analyze turns reuse them instead of re-parsing.
const parsed = new Map<string, Promise<ExcelJS.Worksheet[]>>();
function open(bytes: Uint8Array) {
  const key = createHash("sha256").update(bytes).digest("hex");
  let sheets = parsed.get(key);
  if (!sheets) {
    sheets = parse(bytes);
    sheets.catch(() => parsed.delete(key));
    parsed.set(key, sheets);
    if (parsed.size > 3) parsed.delete(parsed.keys().next().value!);
  }
  return sheets;
}

async function parse(bytes: Uint8Array) {
  if (bytes.length > 5 * 1024 * 1024) throw new Error("실험 기능은 5MB 이하 XLSX를 지원합니다.");
  const book = await loadWorkbook(bytes);
  const sheets = book.worksheets;
  if (!sheets.length || sheets.length > 100) throw new Error("시트는 1~100개까지 지원합니다.");
  await restoreEmptyFormulaCaches(bytes, sheets);
  return sheets;
}

/** ExcelJS drops cached empty strings on load. Recover only explicit string caches from XLSX, never infer a value. */
async function restoreEmptyFormulaCaches(bytes: Uint8Array, sheets: ExcelJS.Worksheet[]) {
  const missing = new Map<ExcelJS.Worksheet, Set<string>>();
  for (const sheet of sheets) sheet.eachRow((row) => row.eachCell((cell) => {
    if (cell.type !== ExcelJS.ValueType.Formula || cell.result !== undefined) return;
    if (!missing.has(sheet)) missing.set(sheet, new Set());
    missing.get(sheet)!.add(cell.address);
  }));
  if (!missing.size) return;
  const zip = await JSZip.loadAsync(bytes);
  const readXml = async (path: string) => {
    const file = zip.file(path);
    if (!file) throw new Error(`XLSX 구성 파일이 없습니다: ${path}`);
    const text = await file.async("string");
    if (/<!DOCTYPE/i.test(text)) throw new Error("DOCTYPE이 포함된 XLSX XML은 지원하지 않습니다.");
    return new DOMParser({ onError: (level, message) => { if (level !== "warning") throw new Error(message); } }).parseFromString(text, "application/xml");
  };
  const workbook = await readXml("xl/workbook.xml");
  const relationships = await readXml("xl/_rels/workbook.xml.rels");
  for (const [sheet, addresses] of missing) {
    const entry = Array.from(workbook.getElementsByTagNameNS("*", "sheet")).find((node) => node.getAttribute("name") === sheet.name);
    const id = entry?.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
    const relation = Array.from(relationships.getElementsByTagNameNS("*", "Relationship")).find((node) => node.getAttribute("Id") === id);
    const target = relation?.getAttribute("Target");
    if (!target || relation?.getAttribute("TargetMode") === "External") throw new Error("시트의 내부 경로를 확인할 수 없습니다.");
    const path = posix.normalize(target.startsWith("/") ? target.slice(1) : posix.join("xl", target));
    if (path.startsWith("../") || /[\\?#]/.test(path)) throw new Error("잘못된 XLSX 내부 경로입니다.");
    const xml = await readXml(path);
    for (const node of Array.from(xml.getElementsByTagNameNS("*", "c"))) {
      const address = node.getAttribute("r") ?? "";
      if (!addresses.has(address) || node.getAttribute("t") !== "str" || node.getElementsByTagNameNS("*", "v")[0]?.textContent !== "") continue;
      const cell = sheet.getCell(address), v = cell.value;
      if (v && typeof v === "object" && ("formula" in v || "sharedFormula" in v)) cell.value = { ...v, result: "" };
    }
  }
}

const sourceCell = (cell: ExcelJS.Cell) => cell.isMerged ? cell.master : cell;
const isFormula = (cell: ExcelJS.Cell) => sourceCell(cell).type === ExcelJS.ValueType.Formula;

function value(cell: ExcelJS.Cell): Cell {
  const source = sourceCell(cell);
  let v = source.value;
  if (source.type === ExcelJS.ValueType.Formula) {
    // shortcut: use Excel's saved result; add a real calculation engine if unsaved formulas must be recalculated.
    // ExcelJS's value getter drops 0/false/empty-string caches; result preserves them.
    const result = source.result;
    if (result === undefined || result === null) throw new Error(`${source.address}: 수식의 저장된 계산 결과가 없습니다. Excel에서 수식을 재계산하고 저장한 뒤 다시 실행해 주세요.`);
    v = result;
  }
  if (v && typeof v === "object" && "error" in v) throw new Error(`${source.address}: Excel 오류 ${v.error}. 해당 수식이나 원본 값을 확인해 주세요.`);
  if (v == null) return null;
  if (v instanceof Date && Number.isFinite(v.getTime())) return v.toISOString().endsWith("T00:00:00.000Z") ? v.toISOString().slice(0, 10) : v.toISOString();
  if (typeof v === "string" && v.length <= 2000) return v;
  if (typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER) return v;
  if (typeof v === "boolean") return String(v);
  if (typeof v === "object" && "richText" in v) {
    const text = v.richText.map((part) => part.text).join("");
    if (text.length <= 2000) return text;
  }
  if (typeof v === "object" && "hyperlink" in v && v.text.length <= 2000) return v.text;
  throw new Error("지원하지 않는 셀 값 또는 너무 긴 셀입니다.");
}

function cellMetadata(cell: ExcelJS.Cell): CellMetadata {
  const source = sourceCell(cell), numFmt = source.numFmt || "General";
  let raw: Cell = null, error: string | undefined;
  try { raw = value(source); } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
  const original = isFormula(source) ? source.result : source.value;
  const date = original instanceof Date ? original : undefined;
  const dateSerial = date ? date.getTime() / 86400000 + 25569 - (source.worksheet.workbook.properties.date1904 ? 1462 : 0) : undefined;
  let display = raw === null ? "" : String(raw);
  try { display = format(numFmt, dateSerial ?? raw ?? "", { date1904: !!source.worksheet.workbook.properties.date1904 }); }
  catch { error ??= "표시 형식을 해석하지 못했습니다. 원시 값과 numFmt를 확인하세요."; }
  return { display, numFmt, ...(isFormula(source) ? { formula: source.formula } : {}), ...(error ? { error } : {}),
    ...(date ? { dateTime: date.toISOString(), dateSerial } : {}), ...(source.fill ? { fill: source.fill } : {}), ...(source.font?.color ? { fontColor: source.font.color } : {}) };
}

export async function profileWorkbook(bytes: Uint8Array, query = "", inspection?: ProfileInspection): Promise<WorkbookProfile> {
  let sheets = await open(bytes);
  if (inspection) {
    inspection = profileInspection.parse(inspection);
    const selectedSheet = inspection.sheet;
    sheets = sheets.filter(sheet => sheet.name === selectedSheet);
    if (!sheets.length) throw new Error("확인할 시트가 없습니다. 실제 시트명을 사용하세요.");
    if ((inspection.startRow ?? 1) > sheets[0].rowCount) throw new Error("확인할 시작 행이 시트 범위 밖입니다.");
  }
  const normalize = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const normalizedQuery = normalize(query);
  const terms = [...new Set(query.split(/\s+/).map(normalize).filter(term => term.length >= 1))];
  const addresses = [...new Set([...query.normalize("NFKC").matchAll(/(?<![A-Za-z0-9_$])\$?([A-Za-z]{1,3})[ \t]*\$?([1-9]\d{0,6})(?![A-Za-z0-9_])/g)].map(match => `${match[1].toUpperCase()}${match[2]}`))];
  return { sheets: sheets.map((sheet) => {
    const firstColumn = inspection?.startColumn ?? 1;
    const lastColumn = inspection?.endColumn ?? Math.min(sheet.columnCount, firstColumn + 49);
    if (inspection && (firstColumn > sheet.columnCount || lastColumn < firstColumn || lastColumn > sheet.columnCount || lastColumn - firstColumn >= 50)) throw new Error("열람 범위는 시트 안의 연속된 최대 50열이어야 합니다.");
    const start = inspection?.startRow ?? 1;
    const end = inspection?.endRow ?? Math.min(sheet.rowCount, start + 39);
    if (inspection && (end < start || end > sheet.rowCount || end - start >= 80)) throw new Error("열람 범위는 시트 안의 최대 80행이어야 합니다.");
    const requestedCells = addresses.slice(0, 10).map(address => {
      const letters = address.match(/^[A-Z]+/)![0];
      const column = [...letters].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0);
      const row = Number(address.slice(letters.length));
      return { address, row, column, inBounds: row <= sheet.rowCount && column <= sheet.columnCount };
    });
    const matches: { row: number; score: number }[] = [];
    const outline: WorkbookProfile["sheets"][number]["outline"] = { entries: [], nextRow: null };
    const seenLabels = new Set<string>();
    sheet.eachRow(row => {
      let score = 0;
      const labels: string[] = [];
      const indexedLabels: string[] = [];
      row.eachCell(cell => {
        try {
          const v = value(cell);
          if (v === null) return;
          const label = normalize(String(v));
          if (!label) return;
          if (!cell.isMerged || cell.master.address === cell.address) {
            labels.push(`${cell.address}: ${String(v).slice(0, 80)}`);
            indexedLabels.push(`${cell.col}:${label}`);
          }
          if (normalizedQuery && normalizedQuery.includes(label)) score = Math.max(score, 1000 + label.length);
          else for (const term of terms) if (label.includes(term)) score = Math.max(score, term.length);
        } catch { /* Unreadable cells are reported if their row is shown, never treated as a text match. */ }
      });
      if (score) matches.push({ row: row.number, score });
      const signature = indexedLabels.join("|");
      if (row.number >= (inspection?.startRow ?? 1) && signature && !seenLabels.has(signature)) {
        seenLabels.add(signature);
        if (outline.entries.length < 60) outline.entries.push({ row: row.number, text: labels.join(" | ").slice(0, 300) });
        else outline.nextRow ??= row.number;
      }
    });
    matches.sort((a, b) => b.score - a.score || a.row - b.row);
    const selected = new Set(Array.from({ length: Math.min(20, sheet.rowCount) }, (_, i) => i + 1));
    if (inspection?.startRow || inspection?.endRow) {
      selected.clear();
      for (let row = start; row <= end; row++) selected.add(row);
    }
    const anchors = requestedCells.filter(cell => cell.inBounds);
    const explicitRows = inspection?.startRow !== undefined || inspection?.endRow !== undefined;
    if (!explicitRows) {
      for (const cell of anchors) selected.add(cell.row);
      for (const offset of [-1, 1, -2, 2, -3, 3, -4, 4, -5, 5, 6, 7, 8, 9, 10]) for (const cell of anchors) {
        const n = cell.row + offset;
        if (n >= 1 && n <= sheet.rowCount && selected.size < 80) selected.add(n);
      }
      for (const match of matches.slice(0, 30)) if (selected.size < 80) selected.add(match.row);
      for (const match of matches.slice(0, 30)) for (const n of [match.row - 1, match.row + 1]) {
        if (n >= 1 && n <= sheet.rowCount && selected.size < 80) selected.add(n);
      }
    }
    const shownMatchRows = matches.filter(match => selected.has(match.row)).map(match => match.row).sort((a, b) => a - b);
    const search = { matchedRowCount: matches.length, shownMatchRows, truncated: shownMatchRows.length < matches.length,
      requestedCells, omittedCellCount: Math.max(0, addresses.length - requestedCells.length) };
    const mergedCells: Record<string, string> = {};
    const metadata: Record<string, CellMetadata> = {};
    const formulaCells: string[] = [];
    const issues: { address: string; message: string }[] = [];
    const preview = [...selected].sort((a, b) => a - b).map(n => ({ row: n,
      cells: Array.from({ length: Math.max(0, lastColumn - firstColumn + 1) }, (_, j) => {
        const cell = sheet.getRow(n).getCell(j + firstColumn);
        metadata[cell.address] = cellMetadata(cell);
        if (cell.isMerged) mergedCells[cell.address] = sourceCell(cell).address;
        if (isFormula(cell)) formulaCells.push(cell.address);
        try { const v = value(cell); return typeof v === "string" ? v.slice(0, 120) : v; }
        catch (error) { issues.push({ address: cell.address, message: error instanceof Error ? error.message : String(error) }); return null; }
      }),
    }));
    return { name: sheet.name, state: sheet.state, firstColumn, metadata, conditionalFormatting: (sheet as ExcelJS.Worksheet & { conditionalFormattings?: unknown[] }).conditionalFormattings ?? [], rows: sheet.rowCount, columns: sheet.columnCount, outline, search, preview, mergedCells, formulaCells, issues };
  }) };
}

export async function readAnalysisRows(bytes: Uint8Array, plan: SheetPlan) {
  return extractRows(await open(bytes), plan);
}

function extractRows(sheets: ExcelJS.Worksheet[], plan: SheetPlan): { rows: InputRow[]; blankRows: number; sourceNotes: string[] } {
  const sheet = sheets.find((item) => item.name === plan.sheet);
  if (!sheet || plan.headerRow >= sheet.rowCount) throw new Error("시트 또는 헤더 다음의 데이터 행을 확인해 주세요.");
  const headerStart = plan.headerStartRow ?? plan.headerRow;
  const firstDataRow = plan.firstDataRow ?? plan.headerRow + 1;
  const lastDataRow = plan.lastDataRow ?? sheet.rowCount;
  if (lastDataRow < firstDataRow || lastDataRow > sheet.rowCount || lastDataRow - firstDataRow >= 10000) throw new Error("분석 범위는 시트 안의 최대 10,000행이어야 합니다.");
  if ((plan.headerRow === 0 && headerStart !== 0) || headerStart > plan.headerRow || firstDataRow <= plan.headerRow || firstDataRow > sheet.rowCount) throw new Error("헤더 시작·끝 행과 데이터 시작 행의 순서를 확인해 주세요.");
  const indices = new Set<number>(), keys = new Map<string, number>();
  for (const column of plan.columns) {
    if (indices.has(column.index)) throw new Error(`${plan.sheet}: 분석 계획에서 ${column.index}열을 중복 선택했습니다. columns에는 같은 index를 한 번만 넣고 코드에서 재사용하세요.`);
    indices.add(column.index);
    const key = column.key ?? column.name;
    if (!key.trim()) throw new Error(`${plan.sheet}: ${column.index}열의 헤더가 비어 있습니다. name은 빈 문자열로 유지하고 key를 c${column.index}처럼 지정해 코드의 values[key]로 읽으세요.`);
    if (keys.has(key)) throw new Error(`${plan.sheet}: ${keys.get(key)}열과 ${column.index}열의 분석 식별자 "${key}"가 같습니다. 원본 name은 유지하고 각 열에 c${keys.get(key)}, c${column.index}처럼 서로 다른 key를 지정한 뒤 코드의 values[key]와 sourceCells[key]도 맞춰 주세요.`);
    keys.set(key, column.index);
  }
  const formulas = new Set<string>(), merged = new Set<string>();
  for (const column of plan.columns) {
    if (column.index > sheet.columnCount) throw new Error(`선택한 ${column.index}열은 시트 범위(${sheet.columnCount}열) 밖입니다.`);
    const labels: string[] = [];
    const seen = new Set<string>();
    for (let n = Math.max(1, headerStart); n <= plan.headerRow; n++) {
      const cell = sourceCell(sheet.getRow(n).getCell(column.index));
      if (isFormula(cell)) formulas.add(cell.address);
      if (cell.isMerged) merged.add(cell.address);
      if (seen.has(cell.address)) continue;
      seen.add(cell.address);
      const label = String(value(cell) ?? "").trim();
      if (label) labels.push(label);
    }
    if (labels.join(" / ") !== column.name) throw new Error(`선택한 ${column.index}열과 원본 헤더가 일치하지 않습니다. 실제 헤더: ${labels.join(" / ")}`);
  }
  const rows: InputRow[] = []; let blankRows = 0;
  const cellErrors = new Set<string>();
  for (let n = firstDataRow; n <= lastDataRow; n++) {
    const row = sheet.getRow(n);
    if (!row.hasValues) { blankRows++; continue; }
    const values: Record<string, Cell> = Object.create(null);
    const sourceCells: Record<string, string> = Object.create(null);
    const metadata: Record<string, CellMetadata> = Object.create(null);
    for (const column of plan.columns) {
      const cell = row.getCell(column.index);
      const key = column.key ?? column.name;
      metadata[key] = cellMetadata(cell);
      if (metadata[key].error) cellErrors.add(sourceCell(cell).address);
      sourceCells[key] = sourceCell(cell).address;
      try {
        values[key] = value(cell);
        sourceCells[key] = sourceCell(cell).address;
        if (isFormula(cell)) formulas.add(sourceCell(cell).address);
        if (cell.isMerged) merged.add(sourceCell(cell).address);
      }
      catch (error) {
        if (!plan.allowCellErrors) throw new Error(`${plan.sheet}!${cell.address}: ${error instanceof Error ? error.message : String(error)}`);
        values[key] = null;
      }
    }
    rows.push({ id: n, rangeId: plan.rangeId, fileId: plan.fileId, sheet: plan.sheet, row: n, values, sourceCells, metadata });
  }
  if (JSON.stringify(rows).length > 8 * 1024 * 1024) throw new Error("분석 데이터는 8MB 이하로 줄여 주세요.");
  const sourceNotes = [`원본 범위: ${plan.sheet}, 헤더 ${headerStart}-${plan.headerRow}행, 데이터 ${firstDataRow}-${lastDataRow}행.`];
  if (cellErrors.size) sourceNotes.push(`확인할 셀 ${cellErrors.size}개: ${[...cellErrors].slice(0, 20).join(", ")}. metadata.error를 확인하세요. 오류 값은 0으로 대체하지 않았습니다.`);
  if (formulas.size) sourceNotes.push(`수식 ${formulas.size}개의 저장된 계산 결과를 사용했습니다. 앱에서 재계산하지 않았으므로 원본의 마지막 저장 시점 기준입니다.`);
  if (merged.size) sourceNotes.push(`병합 영역 ${merged.size}개의 기준 셀 값을 읽었습니다. 같은 원본 셀의 숫자가 여러 행에 표시될 수 있으므로 중복 합산 여부를 확인해 주세요.`);
  return { rows, blankRows, sourceNotes };
}

/** Parse each workbook once; row IDs are unique across files and sheets. */
export async function readAnalysisInputs(files: WorkbookInput[], plan: AnalysisPlan) {
  if (!files.length || files.length > 10 || new Set(files.map(f => f.id)).size !== files.length) throw new Error("엑셀 파일은 서로 다른 ID로 1~10개 지정해 주세요.");
  const selected = new Set<string>();
  const rangeIds = new Set<string>();
  for (const input of plan.inputs) {
    if (!files.some(f => f.id === input.fileId)) throw new Error(`선택하지 않은 파일입니다: ${input.fileId}`);
    const key = JSON.stringify([input.fileId, input.sheet, input.firstDataRow ?? input.headerRow + 1, input.lastDataRow ?? null, input.columns.map(c => c.index).sort((a,b)=>a-b)]);
    if (selected.has(key)) throw new Error("같은 파일·시트·셀 범위를 중복 분석할 수 없습니다.");
    selected.add(key);
    if (input.rangeId && rangeIds.has(input.rangeId)) throw new Error("rangeId는 분석 범위마다 고유해야 합니다.");
    if (input.rangeId) rangeIds.add(input.rangeId);
  }
  const rows: InputRow[] = [], sourceNotes: string[] = [];
  let blankRows = 0;
  for (const file of files) {
    if (!plan.inputs.some(input => input.fileId === file.id)) { sourceNotes.push(`[${file.id}] ${file.name}: 분석 계획에서 제외한 파일.`); continue; }
    try {
      const sheets = await open(file.bytes);
      for (const input of plan.inputs.filter(p => p.fileId === file.id)) {
        const data = extractRows(sheets, input);
        for (const row of data.rows) rows.push({ ...row, id: rows.length + 1 });
        if (rows.length > 10000) throw new Error("전체 분석 대상은 합계 10,000행까지 지원합니다.");
        blankRows += data.blankRows;
        sourceNotes.push(...data.sourceNotes.map(note => `[${file.id}] ${file.name}: ${note}`));
      }
    } catch (error) { throw new Error(`[${file.id}] ${file.name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (JSON.stringify(rows).length > 8 * 1024 * 1024) throw new Error("전체 분석 데이터는 8MB 이하로 줄여 주세요.");
  const rowSources = Object.fromEntries(rows.map(({ id, fileId, sheet, row, rangeId }) => [id, { fileId, sheet, row, ...(rangeId ? { rangeId } : {}) }]));
  return { rows, blankRows, sourceNotes, rowSources };
}
