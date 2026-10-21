// @vitest-environment node
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import type { SourceMapping } from "../../src/app-types/WorkSource.types.ts";
import { extractRows, inspectWorkbook, loadWorkbook } from "./mapping.ts";

const mapping: SourceMapping = {
  sheet: "입출금", headerRow: 2, firstDataRow: 3,
  columns: [
    { field: "date", header: "거래일", type: "date", required: true },
    { field: "accountId", header: "계좌", type: "text", required: true },
    { field: "outflow", header: "출금액", type: "decimal", required: true },
  ], filters: [{ field: "date", operator: "equals", value: "2026-10-14" }],
};
function fixture() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("입출금");
  sheet.addRows([["ERP 내역"], ["계좌", "출금액", "거래일"], ["00123", "1,234.50", "2026/10/14"], ["00123", 0, "2026-10-14"], ["00123", 42, "2026-10-13"]]);
  return workbook;
}

describe("source mapping", () => {
  it("previews empty merged cells without duplicating merged header labels", () => {
    const workbook = fixture(); const sheet = workbook.worksheets[0];
    sheet.mergeCells("D2:E2"); sheet.mergeCells("D3:E3");
    sheet.getCell("D2").value = "참고";
    const result = inspectWorkbook(workbook, "hash", "입출금", 2);
    expect(result.headers[4].text).toBe("");
    expect(result.rows[1].cells[4].text).toBe("");
  });

  it("reads an XLSX roundtrip, maps by header, filters by date and keeps cell provenance", async () => {
    const workbook = await loadWorkbook(new Uint8Array(await fixture().xlsx.writeBuffer()));
    const overview = inspectWorkbook(workbook, "hash", "입출금", 2);
    expect(overview.rows[0].cells[0]).toMatchObject({ address: "A2", text: "계좌" });
    const result = extractRows(workbook, "hash", mapping);
    expect(result).toMatchObject({ scannedRows: 3, matchedRows: 2, excludedRows: 1, issueCount: 0 });
    expect(result.rows[0]).toEqual({ row: 3, values: { date: "2026-10-14", accountId: "00123", outflow: "1234.5" }, cells: { date: "C3", accountId: "A3", outflow: "B3" } });
    expect(result.rows[1].values.outflow).toBe("0");
  });

  it("does not hide missing values, invalid numbers, formulas or impossible dates as zero", () => {
    const workbook = fixture(); const sheet = workbook.worksheets[0];
    sheet.addRows([["00123", null, "2026-10-14"], ["00123", "12,34", "2026-10-14"], ["00123", { formula: "1+1", result: 2 }, "2026-10-14"], ["00123", 5, "2026-02-30"]]);
    const result = extractRows(workbook, "hash", mapping);
    expect(result.issueCount).toBe(4);
    expect(result.matchedRows).toBe(2);
    expect(result.issues.map((issue) => issue.row)).toEqual([6, 7, 8, 9]);
  });

  it("rejects missing/duplicate headers, invalid ranges and duplicate target fields", () => {
    const workbook = fixture();
    workbook.worksheets[0].getCell("D2").value = "계좌";
    expect(() => extractRows(workbook, "hash", mapping)).toThrow("중복");
    expect(() => extractRows(fixture(), "hash", { ...mapping, sheet: "없음" })).toThrow("시트");
    expect(() => extractRows(fixture(), "hash", { ...mapping, lastDataRow: 999 })).toThrow("범위");
    expect(() => extractRows(fixture(), "hash", { ...mapping, firstDataRow: 1 })).toThrow("헤더");
    expect(() => extractRows(fixture(), "hash", { ...mapping, columns: [mapping.columns[0], mapping.columns[0]] })).toThrow("중복");
  });

  it("validates the entire range even though the preview contains only twenty rows", () => {
    const workbook = fixture();
    for (let index = 0; index < 30; index++) workbook.worksheets[0].addRow(["00123", index, "2026-10-14"]);
    workbook.worksheets[0].addRow([null, 3, "2026-10-14"]);
    const result = extractRows(workbook, "hash", mapping);
    expect(result.rows).toHaveLength(20);
    expect(result.matchedRows).toBe(32);
    expect(result.issueCount).toBe(1);
    expect(result.issues[0].row).toBe(36);
  });

  it("keeps optional blanks distinct and never silently fills merged rows", () => {
    const workbook = fixture(); const sheet = workbook.worksheets[0];
    sheet.getCell("B3").value = null;
    const optional = { ...mapping, columns: mapping.columns.map((column) => ({ ...column, required: false })) };
    expect(extractRows(workbook, "hash", optional).rows[0].values.outflow).toBeNull();
    sheet.mergeCells("A3:A4");
    expect(extractRows(workbook, "hash", optional).issues[0].message).toContain("병합");
  });
});
