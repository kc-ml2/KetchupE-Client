// @vitest-environment node
import { expect, it } from "vitest";
import { fixtureBooks } from "./fixtures.ts";
import { rolloverFormulas } from "./report.ts";
import { SelectiveWorkbook } from "../../work/selectiveWorkbook.ts";

async function fixture(expression: string) {
  const { report } = fixtureBooks();
  const current = report.getWorksheet("261012")!;
  const old = report.addWorksheet("261009");
  old.model = { ...structuredClone(current.model), id: old.id, name: old.name };
  // The referenced historical sheet has a different opening row.
  old.getCell("A130").value = null;
  old.getCell("A129").value = "기초금액(10/9)";
  old.getCell("D156").value = { formula: "SUM(D130:D155)", result: 0 };
  current.getCell("Q245").value = { formula: expression };
  const archive = await SelectiveWorkbook.open(new Uint8Array(await report.xlsx.writeBuffer()));
  return { archive, current };
}

it.each(["D130='261009'!H129", "'261009'!$D$237=$D$130"])("resolves %s using the referenced sheet's actual opening/closing rows", async (expression) => {
  const { archive, current } = await fixture(expression);
  const result = await rolloverFormulas(archive, current);
  expect(result.get("Q245")).toBe(expression.startsWith("D130") ? "D130='261012'!D237" : "'261012'!D237=$D$130");
});

it.each(["D130='[1]261009'!H129", "D130='261009'!H999", "D130='261009'!J129", "D130='261008'!H129"])("rejects an unverified rollover reference: %s", async (expression) => {
  const { archive, current } = await fixture(expression);
  await expect(rolloverFormulas(archive, current)).rejects.toThrow(/추측|확인할 수 없습니다/);
});

it("leaves unrelated formulas intact and does not invent already-deleted checks", async () => {
  const { archive, current } = await fixture("SUM(H10:H13)");
  expect((await rolloverFormulas(archive, current)).size).toBe(0);
  expect(current.getCell("Q245").formula).toBe("SUM(H10:H13)");
  current.getCell("Q245").value = null;
  expect((await rolloverFormulas(archive, current)).size).toBe(0);
});
