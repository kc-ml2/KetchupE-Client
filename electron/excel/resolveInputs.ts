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
  const plan = structuredClone(raw) as Record<string, unknown> & { kind?: string; input?: Input; inputs?: Input[] };
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
  }
  for (const input of plan.inputs ?? []) fill(input);
  return plan;
}
