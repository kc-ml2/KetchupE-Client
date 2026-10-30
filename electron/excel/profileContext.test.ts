// @vitest-environment node
import { expect, it } from "vitest";
import { fitSheetContext, profileContext } from "./profileContext.ts";
import type { WorkbookProfile } from "./contracts.ts";

function sheet(name = "실험"): WorkbookProfile["sheets"][number] {
  return { name, state: "visible", rows: 80, columns: 1, firstColumn: 1,
    preview: Array.from({ length: 80 }, (_, i) => ({ row: i + 1, cells: [i] })),
    metadata: Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`A${i + 1}`, { display: String(i), numFmt: "0", formula: "1+".repeat(500) + "1" }])),
    conditionalFormatting: [{ formulae: ["x".repeat(200000)] }],
    outline: { entries: Array.from({ length: 60 }, (_, i) => ({ row: i + 1, text: `항목 ${i}` })), nextRow: 61 },
    search: { matchedRowCount: 80, shownMatchRows: Array.from({ length: 80 }, (_, i) => i + 1), truncated: false, requestedCells: [], omittedCellCount: 0 },
    mergedCells: { A80: "A79" }, formulaCells: ["A1", "A80"], issues: [{ address: "A80", message: "확인" }] };
}

it("fits large previews without losing sheet identities or mutating the original metadata", () => {
  const original = sheet();
  const result = fitSheetContext(original, 12000);
  expect(JSON.stringify(result).length).toBeLessThanOrEqual(12000);
  expect(result.detailsTruncated).toBe(true);
  expect(result.metadata!.A1.formula).toBe(original.metadata.A1.formula);
  expect(result.metadata).not.toHaveProperty("A80");
  expect(result.formulaCells).toEqual(["A1"]);
  expect(result.issues).toEqual([]);
  expect(result.search!.truncated).toBe(true);
  expect(result.outline!.nextRow).toBe(original.outline.entries[result.outline!.entries.length].row);
  expect(original.preview).toHaveLength(80);
  expect(original.metadata).toHaveProperty("A80");
  expect(fitSheetContext(original, 250)).toMatchObject({ name: "실험", rows: 80, columns: 1, detailsTruncated: true });
});

it("keeps all 100 sheets across 10 files discoverable within the total context budget", () => {
  const original = sheet();
  const profiles = Array.from({ length: 10 }, (_, i) => ({ fileId: `file${i + 1}`, name: `파일${i}.xlsx`,
    sheets: Array.from({ length: 100 }, (_, j) => ({ ...original, name: `${"긴시트이름".repeat(5)}${j}`, state: j === 99 ? "hidden" : "visible" })) }));
  const result = profileContext(profiles);
  expect(result).toHaveLength(10);
  expect(result.every(file => file.sheets.length === 100)).toBe(true);
  expect(result[9].sheets[99]).toMatchObject({ name: profiles[9].sheets[99].name, state: "hidden", detailsTruncated: true });
  expect(JSON.stringify(result).length).toBeLessThan(198000);
});

it("keeps small previews unchanged", () => {
  const original = sheet(); original.conditionalFormatting = []; original.metadata = {};
  expect(profileContext([{ fileId: "file1", name: "파일.xlsx", sheets: [original] }])[0].sheets[0]).toEqual(original);
});
