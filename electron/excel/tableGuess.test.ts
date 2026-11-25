import { describe, expect, it } from "vitest";
import type { Cell } from "./contracts.ts";
import { chartRequest } from "./contracts.ts";
import { guessTable } from "./tableGuess.ts";
import { resolveInputs } from "./resolveInputs.ts";

const grid = (rows: Cell[][]) => guessTable(rows.length, Math.max(...rows.map(r => r.length)), (r, c) => rows[r - 1]?.[c - 1] ?? null);

describe("guessTable", () => {
  it("skips blank rows on top and reads a TGA header with bracketed units", () => {
    const t = grid([[null], [null], ["", "Time (min)", "Temperature (C)", "Weight (%)", "D.W (%/C)"], ...Array.from({ length: 5 }, (_, i) => ["", i, 30 + i * 10, 100 - i, i / 10])])!;
    expect(t).toMatchObject({ headerRow: 3, firstDataRow: 4, lastDataRow: 8 });
    expect(t.columns.map(c => [c.letter, c.unit, c.type])).toEqual([["B", "min", "number"], ["C", "C", "number"], ["D", "%", "number"], ["E", "%/C", "number"]]);
    expect(t.columns[2]).toMatchObject({ min: 96, max: 100 });
  });

  it("recognises a units row under the headers (run log layout)", () => {
    const t = grid([["런ID", "일자", "반응기", "CNT수율"], ["-", "yyyy-mm-dd", "-", "g/g-cat"], ["R1-1", "2026-03-02", "R1", 26.1], ["R2-1", "2026-03-02", "R2", 24.9], ["R1-2", "2026-03-03", "R1", 27.0]])!;
    expect(t).toMatchObject({ headerRow: 1, unitsRow: 2, firstDataRow: 3, lastDataRow: 5 });
    expect(t.columns[1]).toMatchObject({ type: "date", min: "2026-03-02" });
    expect(t.columns[2]).toMatchObject({ type: "text", distinct: 2, values: ["R1", "R2"] });
    expect(t.columns[3]).toMatchObject({ unit: "g/g-cat", type: "number" });
  });

  it("returns nothing for a sheet without a header-and-data table", () => {
    expect(grid([["메모"], ["내용만 있음"]])).toBeUndefined();
  });
});

describe("resolveInputs", () => {
  const table = grid([[null], ["", "Time (min)", "Temperature (C)", "Weight (%)", "D.W (%/C)"], ...Array.from({ length: 3 }, (_, i) => ["", i, 30 + i, 100 - i, i])])!;
  const profiles = [{ fileId: "file1", sheets: [{ name: "normal", table }, { name: "acid", table }] }];

  it("completes a chart plan written with column letters and names only", () => {
    const raw = { kind: "chart", title: "TGA", format: "html", steps: ["그래프"], assumptions: [],
      input: { sheet: "normal", columns: [{ letter: "C", key: "x" }, { name: "Weight", key: "w" }, { letter: "e", key: "d" }] },
      x: { key: "x" }, series: [{ key: "w", axis: "left" }, { key: "d", axis: "right" }] };
    const plan = chartRequest.parse(resolveInputs(raw, profiles));
    expect(plan.input).toMatchObject({ fileId: "file1", headerRow: 2, firstDataRow: 3, lastDataRow: 5 });
    expect(plan.input.columns).toEqual([{ index: 3, name: "Temperature (C)", key: "x" }, { index: 4, name: "Weight (%)", key: "w" }, { index: 5, name: "D.W (%/C)", key: "d" }]);
    expect(plan.x).toEqual({ key: "x", label: "Temperature", unit: "C" });
    expect(plan.series[1]).toMatchObject({ label: "D.W", unit: "%/C" });
  });

  it("keeps what the model wrote and leaves a different header row alone", () => {
    const raw = { kind: "execute", inputs: [{ fileId: "file1", sheet: "acid", headerRow: 1, columns: [{ index: 2, name: "직접", key: "a" }] }] };
    expect((resolveInputs(raw, profiles) as typeof raw).inputs[0]).toEqual({ fileId: "file1", sheet: "acid", headerRow: 1, columns: [{ index: 2, name: "직접", key: "a" }] });
  });
});
