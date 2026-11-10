import type { InputRow, SourceRef } from "./contracts.ts";

export type SourceRange = SourceRef & { firstId: number; count: number };
export type RowSources = Record<number, SourceRef> | SourceRange[];

/** Consecutive input IDs and worksheet rows share one source entry; gaps start another. */
export function compressSources(rows: InputRow[]): SourceRange[] {
  const ranges: SourceRange[] = [];
  for (const { id, fileId, sheet, row, rangeId } of rows) {
    const last = ranges.at(-1);
    if (last && last.fileId === fileId && last.sheet === sheet && last.rangeId === rangeId && last.firstId + last.count === id && last.row + last.count === row) last.count++;
    else ranges.push({ firstId: id, count: 1, fileId, sheet, row, ...(rangeId ? { rangeId } : {}) });
  }
  return ranges;
}

export function sourceFor(sources: RowSources, id: number): SourceRef | undefined {
  if (!Array.isArray(sources)) return sources[id];
  let lo = 0, hi = sources.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1, range = sources[mid];
    if (id < range.firstId) hi = mid - 1;
    else if (id >= range.firstId + range.count) lo = mid + 1;
    else return { fileId: range.fileId, sheet: range.sheet, rangeId: range.rangeId, row: range.row + id - range.firstId };
  }
}
