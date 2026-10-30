import type { WorkbookProfile } from "./contracts.ts";

type Sheet = WorkbookProfile["sheets"][number];
export type ContextSheet = Pick<Sheet, "name" | "state" | "rows" | "columns" | "firstColumn"> & Partial<Sheet> & { detailsTruncated?: boolean };
type Profile = { fileId: string; name: string; sheets: Sheet[] };
const size = (value: unknown) => JSON.stringify(value).length;
const inventory = (sheet: ContextSheet): ContextSheet => ({ name: sheet.name, state: sheet.state, rows: sheet.rows, columns: sheet.columns, firstColumn: sheet.firstColumn, detailsTruncated: true });

/** Only the model preview is shortened; inspect and analysis still read the original workbook. */
export function fitSheetContext(sheet: ContextSheet, budget: number): ContextSheet {
  if (budget <= size(inventory(sheet))) return inventory(sheet);
  if (size(sheet) <= budget) return sheet;
  const result: ContextSheet = { ...sheet, conditionalFormatting: [], detailsTruncated: true };
  while (size(result) > budget && ((result.preview?.length ?? 0) > 1 || (result.outline?.entries.length ?? 0) > 0)) {
    if (result.outline?.entries.length) {
      const count = Math.floor(result.outline.entries.length / 2);
      result.outline = { entries: result.outline.entries.slice(0, count), nextRow: result.outline.entries[count].row };
    }
    if ((result.preview?.length ?? 0) > 1) {
      result.preview = result.preview!.slice(0, Math.ceil(result.preview!.length / 2));
      const rows = new Set(result.preview.map(row => row.row));
      const included = (address: string) => rows.has(Number(address.replace(/^[A-Z]+/, "")));
      result.metadata = Object.fromEntries(Object.entries(result.metadata ?? {}).filter(([address]) => included(address)));
      result.mergedCells = Object.fromEntries(Object.entries(result.mergedCells ?? {}).filter(([address]) => included(address)));
      result.formulaCells = result.formulaCells?.filter(included);
      result.issues = result.issues?.filter(issue => included(issue.address));
      if (result.search) {
        const shownMatchRows = result.search.shownMatchRows.filter(row => rows.has(row));
        result.search = { ...result.search, shownMatchRows, truncated: shownMatchRows.length < result.search.matchedRowCount };
      }
    }
  }
  return size(result) <= budget ? result : inventory(sheet);
}

export function profileContext(profiles: Profile[], budget = 100000) {
  const result = profiles.map(file => ({ ...file, sheets: file.sheets.map(inventory) }));
  // All sheet identities remain discoverable, even when the inventory alone exceeds the sample budget.
  let available = Math.max(0, budget - size(result));
  let remaining = profiles.reduce((count, file) => count + file.sheets.length, 0);
  profiles.forEach((file, i) => file.sheets.forEach((sheet, j) => {
    const base = size(result[i].sheets[j]);
    const fitted = fitSheetContext(sheet, base + Math.floor(available / remaining--));
    available -= size(fitted) - base;
    result[i].sheets[j] = fitted;
  }));
  return result;
}
