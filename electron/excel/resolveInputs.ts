import { headerUnit, type TableGuess } from "./tableGuess.ts";
import { splitFilter } from "./chartPlan.ts";

type Sheet = { name: string; table?: TableGuess };
type Profiles = { fileId: string; sheets: Sheet[] }[];
type Column = { index?: number; letter?: string; name?: string; key?: string };
type Input = { fileId?: string; sheet?: string; headerRow?: number; headerStartRow?: number; firstDataRow?: number; lastDataRow?: number; columns?: Column[] };
const squash = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[（(][^()（）]*[）)]\s*$/, "").replace(/[\s_./-]/g, "");

/**
 * Fills what the model may leave out of a plan input from the detected table (plotkit: the model names columns, the
 * tool finds them): header/data rows, column index from a letter or a header name, the exact header text, and a
 * chart axis's label and unit. Runs before schema validation, so the stored plan is always the complete sheetPlan.
 */
export function resolveInputs(raw: unknown, profiles: Profiles): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const plan = structuredClone(raw) as Record<string, unknown> & { kind?: string; input?: Input; inputs?: Input[]; options?: { plan?: unknown }[] };
  // A question's ready-made options are plans too; they are executed without another model call.
  if (plan.kind === "ask" && Array.isArray(plan.options)) for (const option of plan.options) if (option && typeof option === "object" && option.plan) option.plan = resolveInputs(option.plan, profiles);
  const tableFor = (input: Input) => {
    const file = profiles.find(p => p.fileId === input.fileId) ?? (profiles.length === 1 ? profiles[0] : undefined);
    if (file && !input.fileId) input.fileId = file.fileId;
    if (file && !input.sheet && file.sheets.length === 1) input.sheet = file.sheets[0].name;
    return file?.sheets.find(sheet => sheet.name === input.sheet)?.table;
  };
  const fill = (input: Input) => {
    const table = tableFor(input);
    if (!table) return;
    if (input.headerRow === undefined) input.headerRow = table.headerRow;
    if (input.headerRow === table.headerRow) { input.firstDataRow ??= table.firstDataRow; input.lastDataRow ??= table.lastDataRow; }
    for (const column of input.columns ?? []) {
      const hadIndex = column.index !== undefined;
      const found = column.index !== undefined ? table.columns.find(c => c.index === column.index)
        : column.letter ? table.columns.find(c => c.letter === column.letter!.toUpperCase())
        : column.name ? table.columns.find(c => c.name === column.name) ?? table.columns.find(c => squash(c.name) === squash(column.name!)) ?? table.columns.find(c => squash(c.name).includes(squash(column.name!)))
        : undefined;
      // Multi-row headers join several rows, so their names are left as the model wrote them.
      if (found && input.headerRow === table.headerRow && input.headerStartRow === undefined) { if (!hadIndex) column.index = found.index; if (!hadIndex || column.name === undefined) column.name = found.name; }
      delete column.letter;
    }
  };
  if (plan.kind === "chart" && plan.input) {
    // Columns named only in x / series / by / filter are added from the detected table, keyed by the name used.
    const table = tableFor(plan.input), columns = (plan.input.columns ??= []);
    const refs = [(plan.x as { key?: string } | undefined)?.key, ...((plan.series as { key?: string }[] | undefined) ?? []).map(s => s?.key), (plan.by as { key?: string } | undefined)?.key,
      ...((plan.filter as string[] | undefined) ?? []).map(text => typeof text === "string" ? splitFilter(text)?.column : undefined)];
    for (const ref of refs) {
      if (!ref || !table || columns.some(c => c.key === ref || c.name === ref)) continue;
      const hit = table.columns.find(c => c.name === ref) ?? table.columns.find(c => c.letter === ref.toUpperCase()) ?? table.columns.find(c => squash(c.name) === squash(ref)) ?? table.columns.find(c => squash(c.name).includes(squash(ref)));
      if (hit && !columns.some(c => c.index === hit.index && c.key === ref)) columns.push({ index: hit.index, name: hit.name, key: ref });
    }
    fill(plan.input);
    for (const axis of [plan.x, ...((plan.series as unknown[]) ?? [])] as Record<string, string | undefined>[]) {
      if (!axis || typeof axis !== "object") continue;
      const name = columns.find(c => (c.key ?? c.name) === axis.key)?.name;
      if (name === undefined) continue;
      const unit = table?.columns.find(c => c.name === name)?.unit ?? headerUnit(name);
      axis.unit ??= unit ?? "";
      axis.label ??= name.replace(/\s*[（(][^()（）]*[）)]\s*$/, "") || name;
    }
    // A single-axis chart often omits the side; it is the left axis.
    for (const series of ((plan.series as unknown[]) ?? []) as Record<string, unknown>[]) if (series && typeof series === "object") series.axis ??= "left";
  }
  if (plan.kind === "chart" && plan.input && plan.sheets !== undefined) expandSheets(plan as Record<string, unknown> & { input: Input }, profiles, fill);
  for (const input of plan.inputs ?? []) fill(input);
  return plan;
}

/**
 * sheets: ["A", "B"] or "all" (every sheet with a detected table) → one full sheet plan per sheet, cloned from the input
 * template. Columns are found again by header name in each sheet (row bounds too); the template's index is the fallback.
 * One sheet is just the input; combine true/false is accepted for overlay/separate.
 */
function expandSheets(plan: Record<string, unknown> & { input: Input }, profiles: Profiles, fill: (input: Input) => void) {
  const file = profiles.find(p => p.fileId === plan.input.fileId) ?? (profiles.length === 1 ? profiles[0] : undefined);
  const raw = plan.sheets === "all" ? file?.sheets.filter(sheet => sheet.table).map(sheet => sheet.name) ?? [] : Array.isArray(plan.sheets) ? plan.sheets : [];
  if (plan.combine === true) plan.combine = "overlay"; else if (plan.combine === false) plan.combine = "separate";
  const sheets = raw.map(entry => {
    const given: Input = typeof entry === "string" ? { sheet: entry } : entry && typeof entry === "object" ? entry as Input : {};
    if (given.columns && given.headerRow !== undefined && given.fileId) return given;
    const copy: Input = { ...structuredClone(plan.input), ...given };
    if (copy.sheet !== plan.input.sheet && file?.sheets.find(sheet => sheet.name === copy.sheet)?.table) {
      for (const key of ["headerRow", "headerStartRow", "firstDataRow", "lastDataRow"] as const) if (given[key] === undefined) delete copy[key];
      copy.columns = (copy.columns ?? []).map(column => column.name ? { name: column.name, key: column.key ?? column.name } : column);
      fill(copy);
      copy.columns.forEach((column, i) => { column.index ??= plan.input.columns?.[i]?.index; });
    }
    return copy;
  });
  if (sheets.length === 1) { plan.input = sheets[0]; delete plan.sheets; delete plan.combine; }
  else plan.sheets = sheets;
}
