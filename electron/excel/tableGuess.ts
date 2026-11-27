import type { Cell } from "./contracts.ts";

/**
 * The table a sheet most likely holds, so the planner can write a plan without inspecting rows first
 * (plotkit's analyze_table idea: blank rows on top, a units row under the headers, Korean headers).
 * Only a hint: the plan still names real rows/columns, and extraction re-checks the headers.
 */
export type TableGuess = {
  headerRow: number; unitsRow?: number; firstDataRow: number; lastDataRow: number;
  columns: { index: number; letter: string; name: string; unit?: string; type: "number" | "date" | "text" | "mixed"; count: number; min?: number | string; max?: number | string; values?: string[]; distinct?: number }[];
};

const SCAN_HEAD = 30, SCAN_ROWS = 20000, MAX_COLUMNS = 50;
export const columnLetter = (index: number) => { let s = ""; for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; };
const isDate = (v: Cell) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}([T ][\d:.]+Z?)?$/.test(v);
const isLabel = (v: Cell) => typeof v === "string" && v.trim() !== "" && !isDate(v) && !/^-?\d+(\.\d+)?$/.test(v.trim());
const isValue = (v: Cell) => typeof v === "number" || isDate(v);
const UNIT = /^(-|[%‰°℃].*|.*\/.*|[a-zA-Zµμ]{1,6}(\/[a-zA-Z%°]+)?|yyyy.*|g\/g-cat|wt%|sccm|kg|h|s|min)$/i;
/** Unit inside trailing brackets of a header: "Weight (%)" → "%". */
export const headerUnit = (name: string) => name.match(/[（(]([^()（）]+)[）)]\s*$/)?.[1].trim();

export function guessTable(rowCount: number, columnCount: number, get: (row: number, column: number) => Cell): TableGuess | undefined {
  const columns = Math.min(columnCount, MAX_COLUMNS);
  const row = (n: number) => Array.from({ length: columns }, (_, j) => { try { return get(n, j + 1); } catch { return null; } });
  const head = Array.from({ length: Math.min(rowCount, SCAN_HEAD) }, (_, i) => row(i + 1));
  for (let h = 0; h < head.length - 1; h++) {
    const header = head[h], labels = header.map((v, j) => isLabel(v) ? j : -1).filter(j => j >= 0);
    if (labels.length < 2) continue;
    // A row of short unit strings ("-", "°C", "%", "yyyy-mm-dd") between headers and data is a units row.
    const next = head[h + 1], unitCells = labels.filter(j => typeof next[j] === "string" && UNIT.test(String(next[j]).trim()));
    const unitsRow = unitCells.length >= Math.max(2, labels.length / 2) && !labels.some(j => isValue(next[j])) ? h + 1 : undefined;
    const first = unitsRow !== undefined ? h + 2 : h + 1;
    const data = head[first];
    if (!data || labels.filter(j => isValue(data[j])).length < 1 || labels.filter(j => data[j] !== null && data[j] !== "").length < labels.length / 2) continue;
    // Data runs until two blank rows in a row (in the header columns) or the scan limit.
    let last = first + 1, blanks = 0;
    const stats = labels.map(() => ({ numbers: [] as number[], dates: [] as string[], texts: new Map<string, number>(), count: 0 }));
    for (let n = first + 1; n <= Math.min(rowCount, first + SCAN_ROWS); n++) {
      const cells = n - 1 < head.length ? head[n - 1] : row(n);
      const values = labels.map(j => cells[j]);
      if (values.every(v => v === null || v === "")) { if (++blanks >= 2) break; continue; }
      blanks = 0; last = n;
      values.forEach((v, k) => {
        if (v === null || v === "") return;
        const s = stats[k]; s.count++;
        if (typeof v === "number") s.numbers.push(v);
        else if (isDate(v)) s.dates.push(v);
        else s.texts.set(String(v).slice(0, 40), (s.texts.get(String(v).slice(0, 40)) ?? 0) + 1);
      });
    }
    return {
      headerRow: h + 1, ...(unitsRow !== undefined ? { unitsRow: unitsRow + 1 } : {}), firstDataRow: first + 1, lastDataRow: last,
      columns: labels.map((j, k) => {
        const s = stats[k], name = String(header[j]).trim(), unit = unitsRow !== undefined && String(next[j]).trim() !== "-" ? String(next[j]).trim() : headerUnit(name);
        const kinds = [s.numbers.length, s.dates.length, s.texts.size ? [...s.texts.values()].reduce((a, b) => a + b, 0) : 0];
        const type = kinds[0] >= s.count * 0.9 ? "number" : kinds[1] >= s.count * 0.9 ? "date" : kinds[2] >= s.count * 0.9 ? "text" : "mixed";
        const base = { index: j + 1, letter: columnLetter(j + 1), name, ...(unit ? { unit } : {}), type, count: s.count } as TableGuess["columns"][number];
        if (type === "number") return { ...base, min: Math.min(...s.numbers), max: Math.max(...s.numbers) };
        if (type === "date") return { ...base, min: s.dates.reduce((a, b) => a < b ? a : b), max: s.dates.reduce((a, b) => a > b ? a : b) };
        return { ...base, distinct: s.texts.size, values: [...s.texts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([v]) => v) };
      }),
    };
  }
}
