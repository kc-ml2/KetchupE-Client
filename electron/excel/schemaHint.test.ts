import { describe, expect, it } from "vitest";
import { analysisResult, planResponse } from "./contracts.ts";
import { allowedKeys, explainSchemaError, normalizeKeys } from "./schemaHint.ts";

const chart = {
  kind: "chart", title: "TGA", format: "html", steps: ["그래프"], assumptions: [],
  input: { fileId: "file1", sheet: "S", headerRow: 1, columns: [{ index: 2, name: "T", key: "x" }, { index: 3, name: "W", key: "y" }] },
  x: { key: "x", label: "T", unit: "C" }, series: [{ key: "y", label: "W", unit: "%", axis: "left" }],
};

describe("schema hints (cases from the plot baseline)", () => {
  it("renames near-miss spellings without touching values", () => {
    const fixed = normalizeKeys(planResponse, { ...chart, view: { charts: { "0": { axes: { x: { tick_step: 200, Min: 0 } } } } } }) as typeof chart & { view: unknown };
    expect(fixed.view).toEqual({ charts: { "0": { axes: { x: { tickStep: 200, min: 0 } } } } });
    expect(planResponse.safeParse(fixed).success).toBe(true);
  });

  it("names the allowed keys and the notApplied route for an unsupported display key", () => {
    const raw = { ...chart, view: { charts: { "0": { watermark: "draft" } } } };
    const result = planResponse.safeParse(raw);
    expect(result.success).toBe(false);
    const text = explainSchemaError(result.error, planResponse, raw, path => path[0] === "view" ? "지원하지 않는 표시 설정이면 이 키를 빼고 notApplied에 적으세요." : undefined)!;
    expect(text).toContain("view.charts.0: 알 수 없는 키 watermark");
    expect(text).toContain("axes");
    expect(text).toContain("notApplied");
  });

  it("explains result-contract errors that crossed the worker as a JSON message", () => {
    const raw = { tables: [], datasets: [{ title: "d", columns: ["x", "y"], rows: [{ cells: [1, 2], sourceRows: [1] }] }], excluded: [], notes: [], charts: [{ type: "line", table: 0, dataset: true, x: 0, y: 1, title: "t", series: [{ y: 1, axis: "left", label: "W", unit: "%" }] }] };
    const parsed = analysisResult.safeParse(raw);
    const text = explainSchemaError(new Error(`분석 실패: ${parsed.error!.message}`), analysisResult, raw)!;
    expect(text).toContain("charts.0.series.0: 알 수 없는 키 label, unit");
    expect(text).toContain("쓸 수 있는 키: y, axis");
  });

  it("reports a missing required value and suggests the closest key", () => {
    const raw = { kind: "inspect", fileId: "file1", sheet: "S", strtRow: 1 };
    const text = explainSchemaError(planResponse.safeParse(raw).error, planResponse, raw)!;
    expect(text).toContain("query: 필수 값");
    expect(text).toContain("strtRow(→ startRow?)");
    expect(allowedKeys(planResponse, [], raw)).toContain("query");
  });
});

describe("parseModelJson", () => {
  it("takes the JSON object out of a reply that starts with a sentence", async () => {
    const { parseModelJson } = await import("./contracts.ts");
    expect(parseModelJson('The previous attempt failed, so here is the plan:\n```json\n{"kind":"finish","summary":"완료"}\n```')).toEqual({ kind: "finish", summary: "완료" });
    expect(() => parseModelJson("no json here")).toThrow();
  });
});
