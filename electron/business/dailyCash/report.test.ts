// @vitest-environment node
import { expect, it } from "vitest";
import { fixtureBooks } from "./fixtures.ts";
import { assignCashMovements, bindAccounts, buildReport, priorAmounts, rolloverFormulas } from "./report.ts";
import { readCashStatus } from "./cashStatus.ts";
import { Money } from "./values.ts";
import type { Movement } from "./weekly.ts";
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

it.each(["D130='261009'!H129", "'261009'!$D$237=$D$130", "D130=TRUNC('261009'!D237,0)", "D130=ROUND('261009'!D237,0)"])("resolves %s using the referenced sheet's actual opening/closing rows", async (expression) => {
  const { archive, current } = await fixture(expression);
  const result = await rolloverFormulas(archive, current);
  expect(result.get("Q245")).toBe(expression.startsWith("D130") ? "D130=ROUND('261012'!D237,0)" : "ROUND('261012'!D237,0)=$D$130");
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

it("replaces legacy TRUNC wrappers with ROUND and preserves rate precision", () => {
  const { report } = fixtureBooks(); const prior = report.getWorksheet(1)!;
  prior.getCell("H21").value = 1.5; prior.getCell("H28").value = -1.5;
  prior.getCell("D21").value = { formula: "TRUNC('261009'!H21,0)", result: 1 };
  prior.getCell("D28").value = { formula: "ROUND('261009'!H28,0)", result: -2 };
  prior.getCell("L21").value = { formula: "TRUNC(H21*K21,0)", result: 0 };
  prior.getCell("L28").value = { formula: "ROUND(H28*K28,0)", result: 0 };
  prior.getCell("F242").value = { formula: "TRUNC(SUM(L21,L28),0)", result: 0 };
  const rates = { date: "2026-10-13", requestedDate: "2026-10-13", round: "1", publishedAt: "fixture", source: "fixture", fetchedAt: "fixture", responseHash: "fixture", perUnit: { USD: "1400.25", JPY: "9.5012", CNY: "200.1" } };
  const { sheet } = buildReport(report, prior, "2026-10-13", "2026-10-14", priorAmounts(prior, {}).values, [], new Map(), [], [], rates, {}, new Map());
  expect(sheet.getCell("D21").value).toEqual({ formula: "ROUND('261012'!H21,0)", result: 2 });
  expect(sheet.getCell("D28").value).toEqual({ formula: "ROUND('261012'!H28,0)", result: -2 });
  expect(sheet.getCell("L21").value).toEqual({ formula: "ROUND(H21*K21,0)", result: 2801 });
  expect(sheet.getCell("L28").value).toEqual({ formula: "ROUND(H28*K28,0)", result: -2801 });
  expect(sheet.getCell("F242").formula).toBe("ROUND(SUM(L21,L28),0)");
  expect(sheet.getCell("K21").value).toBe(1400.25); expect(sheet.getCell("K23").value).toBe(9.5012);
});

function cashFixture(incoming: number, secondIncoming: number) {
  const { report, status } = fixtureBooks(); const prior = report.getWorksheet(1)!;
  prior.getCell("E10").value = { formula: "SUM(D131:D136)", result: 0 };
  prior.getCell("E11").value = { formula: "SUM(D137)", result: 0 };
  const first = readCashStatus(status).accounts[0];
  Object.assign(first, { incoming: new Money(incoming), outgoing: new Money(0), balance: new Money(100000 + incoming) });
  const second = { ...first, key: "140013557473:KRW", incoming: new Money(secondIncoming), opening: new Money(0), balance: new Money(secondIncoming) };
  const accounts = [first, second], amounts = priorAmounts(prior, {}).values;
  const { bindings } = bindAccounts(prior, accounts, amounts, {}, "2026-10-13");
  const rates = { date: "2026-10-13", requestedDate: "2026-10-13", round: "1", publishedAt: "fixture", source: "fixture", fetchedAt: "fixture", responseHash: "fixture", perUnit: { USD: "1400", JPY: "9.5", CNY: "200" } };
  const movement = (amount: number): Movement => ({ date: "2026-10-13", direction: "in", description: "입금", party: "", amount: new Money(amount), source: "fixture" });
  const build = (actual: Movement[]) => buildReport(report, prior, "2026-10-13", "2026-10-14", amounts, accounts, bindings, actual, [], rates, {}, new Map()).sheet;
  return { prior, accounts, bindings, movement, build };
}

it.each([false, true])("follows the actual transaction cells for two accounts (reversed: %s)", (reversed) => {
  const { movement, build } = cashFixture(100, 50);
  const entries = [movement(100), movement(50)]; if (reversed) entries.reverse();
  const sheet = build(entries);
  expect(sheet.getCell("E10").formula).toBe(`SUM(D${reversed ? 132 : 131})`);
  expect(sheet.getCell("E11").formula).toBe(`SUM(D${reversed ? 131 : 132})`);
  // Read actual referenced inputs, ignoring the prefilled formula caches.
  const referenced = (address: string) => sheet.getCell(sheet.getCell(address).formula.match(/^SUM\((D\d+)\)$/)![1]);
  expect(referenced("E10").value).toBe(100); expect(referenced("E11").value).toBe(50);
  referenced("E11").value = 75;
  expect(referenced("E10").value).toBe(100); expect(referenced("E11").value).toBe(75);
});

it("keeps seven incoming payments on their account beyond the former six-row partition", () => {
  const { movement, build } = cashFixture(700, 0);
  const sheet = build(Array.from({ length: 7 }, () => movement(100)));
  const references = sheet.getCell("E10").formula.match(/^SUM\((.*)\)$/)![1].split(",");
  expect(references).toEqual(["D131", "D132", "D133", "D134", "D135", "D136", "D137"]);
  expect(references.reduce((total, address) => total + Number(sheet.getCell(address).value), 0)).toBe(700);
  expect(sheet.getCell("E11").formula).toBe("SUM(0)");
});

it("requires an account only for ambiguous payments and validates explicit selections", () => {
  const { prior, accounts, bindings, movement } = cashFixture(100, 100);
  const entries = [movement(100), movement(100)];
  const assign = (items: Movement[]) => assignCashMovements(prior, accounts, bindings, items, {});
  expect(assign(entries).movements.every((m) => !m.account)).toBe(true);
  const selected = assign([{ ...entries[0], account: "H11" }, entries[1]]);
  expect(selected.issues).toEqual([]); expect(selected.movements.map((m) => m.account)).toEqual(["H11", "H10"]);
  expect(assign([{ ...entries[0], account: "P239" }, entries[1]]).issues.join(" ")).toContain("다시 선택");
  expect(assign(entries.map((m) => ({ ...m, account: "H10" }))).issues.join(" ")).toContain("차이 -100원");
});

it.each([[12, "삼성증권", "96107116718943"], [13, "삼성증권", "555123456789"], [13, "키움증권", "96107116718943"], [15, "삼성증권-MMF", "96107116718943"]] as const)("routes a labeled linked account at row %s (%s, %s), independent of the bank account number", (row, label, code) => {
  const { prior, accounts, movement } = cashFixture(0, 100);
  prior.getCell("C12").value = "삼성증권"; prior.getCell("C15").value = "삼성증권-MMF";
  if (row !== 12 && label === "삼성증권") prior.getCell("C12").value = "다른 증권";
  prior.getCell(`C${row}`).value = label;
  accounts[0].outgoing = new Money(100); accounts[1].key = `${code}:KRW`;
  const description = `신한557434에서 우리${code}(${label} 연동계좌) 자금대체`;
  const incoming = { ...movement(100), description };
  const linked = bindAccounts(prior, accounts, priorAmounts(prior, {}).values, {}, "2026-10-13", [incoming]).bindings;
  expect(linked.get(accounts[1].key)).toBe(`H${row}`);
  const oneLeg = assignCashMovements(prior, accounts, linked, [incoming], {});
  expect(oneLeg.movements).toHaveLength(1); expect(oneLeg.movements[0].account).toBe(`H${row}`);
  const assigned = assignCashMovements(prior, accounts, linked, [incoming, { ...incoming, direction: "out" }], {});
  expect(assigned.issues).toEqual([]); expect(assigned.movements.map((m) => m.account)).toEqual([`H${row}`, "H10"]);
  accounts[0].incoming = new Money(100); accounts[0].outgoing = new Money(0);
  accounts[1].incoming = new Money(0); accounts[1].outgoing = new Money(100);
  const reverse = { ...incoming, description: `우리${code}(${label} 연동계좌)에서 신한557434 자금대체` };
  const reversed = assignCashMovements(prior, accounts, linked, [reverse, { ...reverse, direction: "out" }], {});
  expect(reversed.issues).toEqual([]); expect(reversed.movements.map((m) => m.account)).toEqual(["H10", `H${row}`]);
});

it("does not bind an unannotated Woori number to Samsung and respects its confirmed account", () => {
  const { prior, accounts, movement } = cashFixture(0, 100);
  prior.getCell("C12").value = "삼성증권"; prior.getCell("C13").value = "우리은행";
  accounts[1].key = "96107116718943:KRW";
  const incoming = { ...movement(100), description: "신한557434에서 우리96107116718943 자금대체" };
  const bind = (explicit: Record<string, string>) => bindAccounts(prior, accounts, priorAmounts(prior, {}).values, explicit, "2026-10-13", [incoming]);
  expect(bind({}).bindings.has(accounts[1].key)).toBe(false);
  expect(bind({}).unresolved).not.toEqual([]);
  const assigned = assignCashMovements(prior, accounts, bind({ [accounts[1].key]: "H13" }).bindings, [incoming], {});
  expect(assigned.issues).toEqual([]); expect(assigned.movements[0].account).toBe("H13");
});

it.each(["키움증권", "삼성증권 연동계좌)(키움증권"])("does not fall back to Samsung totals for an unmatched or conflicting linked description: %s", (label) => {
  const { prior, accounts, bindings, movement } = cashFixture(0, 100);
  prior.getCell("C11").value = "삼성증권";
  const incoming = { ...movement(100), description: `신한557434에서 우리96107116718943(${label} 연동계좌) 자금대체` };
  const assigned = assignCashMovements(prior, accounts, bindings, [incoming], {});
  expect(assigned.movements[0].account).toBeUndefined(); expect(assigned.issues.join(" ")).toContain("유일하게 찾을 수 없습니다");
});

it("asks when the KC account name and transfer annotation identify different counterparties", () => {
  const { prior, accounts, movement } = cashFixture(0, 100);
  prior.getCell("C12").value = "삼성증권"; prior.getCell("C13").value = "키움증권";
  accounts[1].key = "96107116718943:KRW"; accounts[1].name = "삼성증권 연동계좌";
  const incoming = { ...movement(100), description: "신한557434에서 우리96107116718943(키움증권 연동계좌) 자금대체" };
  const bound = bindAccounts(prior, accounts, priorAmounts(prior, {}).values, {}, "2026-10-13", [incoming]);
  expect(bound.bindings.has(accounts[1].key)).toBe(false); expect(bound.unresolved.join(" ")).toContain("유일하게 연결할 수 없습니다");
});
