// @vitest-environment node
import { expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import sharp from "sharp";
import { dailyCashTool, applyEdits } from "./dailyCash.ts";
import { bindAccounts, fitDescription, layout, priorAmounts } from "./dailyCash/report.ts";
import { fixtureBooks } from "./dailyCash/fixtures.ts";
import { readCashStatus } from "./dailyCash/cashStatus.ts";
import { readWeekly } from "./dailyCash/weekly.ts";
import { fetchHana, parseHana } from "./dailyCash/hana.ts";
import { Money } from "./dailyCash/values.ts";
import type { BusinessTool } from "./contracts.ts";
vi.mock("./dailyCash/hana.ts", async (original) => ({ ...await original<typeof import("./dailyCash/hana.ts")>(), fetchHana: vi.fn(async (day: string) => ({ date: day, requestedDate: day, round: "10", publishedAt: "테스트 고시", source: "fixture-only", fetchedAt: "2026-10-14T00:00:00Z", responseHash: "fixture", perUnit: { USD: "1400", JPY: "9.5", CNY: "200" } })) }));
async function setup() {
  const books = fixtureBooks(); const file = async (book: ExcelJS.Workbook, name: string) => ({ bytes: Buffer.from(await book.xlsx.writeBuffer()), name, fingerprint: name });
  const input: Parameters<BusinessTool["execute"]>[0] = { values: { workDate: "2026-10-14", actualEdits: "확인", planEdits: "확인" }, files: { previousReport: [await file(books.report, "전일일보.xlsx")], weeklyPlans: [await file(books.weekly, "계획.xlsx")], cashStatus: [await file(books.status, "261013_자금현황표[KC].xlsx")] }, checkpoint: {}, signal: new AbortController().signal };
  return { books, input, file };
}
// Real XLSX/PNG generation needs more time on shared Windows CI runners.
const artifactTestTimeout = 30_000;
async function confirm(input: Parameters<BusinessTool["execute"]>[0]) {
  const review = await dailyCashTool.execute(input);
  expect(review.status, JSON.stringify(review)).toBe("needs_input");
  if (review.status !== "needs_input") throw new Error("review");
  const code = review.fields.find((field) => field.key === "review")?.confirm; expect(code, review.question).toMatch(/^확인 [a-f0-9]{12}$/);
  return dailyCashTool.execute({ ...input, checkpoint: review.checkpoint ?? {}, values: { ...input.values, review: code! } });
}
it("appends a dated sheet, redeems a maturity, reconciles KC cash and returns a real PNG", async () => {
  const { input } = await setup(); const result = await confirm(input);
  expect(result.status, JSON.stringify(result.status === "failed" ? result : {})).toBe("completed");
  if (result.status !== "completed") return;
  const b = new ExcelJS.Workbook(); await b.xlsx.load(Buffer.from(result.file.bytes) as unknown as ExcelJS.Buffer);
  expect(b.worksheets.map((sheet) => sheet.name)).toEqual(["261012", "261013"]);
  expect(b.getWorksheet("261012")!.getCell("H10").value).toBe(100000);
  const s = b.getWorksheet("261013")!;
  expect(s.model.merges).toEqual(b.getWorksheet("261012")!.model.merges);
  expect(s.getCell("C131").master.address).toBe("B131");
  expect(s.getCell("D10").value).toBe(100000); expect(s.getCell("H10").result).toBe(109000);
  expect(s.getCell("G51").value).toBe(10000); expect(s.getCell("H51").result).toBe(0);
  expect(s.getCell("G248").value).toBe(109000); expect(s.getCell("H237").result).toBe(107000);
  expect(s.getCell("K23").value).toBe(9.5); expect(s.getCell("H27").formula).toBe("H26");
  expect(s.getCell("J23").result).toBe(0); expect(s.pageSetup.printArea).toBe("A1:M248");
  expect(Buffer.from(result.image!.bytes).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a"); expect(result.image!.bytes.length).toBeGreaterThan(10000);
  // The PNG (rendered at 2x) spans the visible columns A:P and every visible row through O249, the last KC side-table row.
  // An A:M / 총원화-row render, which cut the 사업부문 자금현황표(KC) off the right edge, would be 702 px narrower and 58 px shorter.
  const SCALE = 2;
  const columnsPx = [6, 15, 23, 18, 6, 18, 15, 18, 17, 3, 25, 20].reduce((total, width) => total + Math.round(width * 7 + 5), 0);
  const rowsPx = Array.from({ length: 249 }, (_, i) => s.getRow(i + 1)).filter((row) => !row.hidden).reduce((total, row) => total + Math.round((row.height ?? 15) * 4 / 3), 0);
  for (const row of [238, 239, 249]) expect(s.getRow(row).hidden, `row ${row}`).toBe(false);
  await expect(sharp(Buffer.from(result.image!.bytes)).metadata()).resolves.toMatchObject({ width: columnsPx * SCALE, height: rowsPx * SCALE });
  expect(result.externalData?.matured).toHaveLength(1);
}, artifactTestTimeout);
it("matches the KC file date to the report date (work date minus one), not the work date", async () => {
  const { input, books, file } = await setup(); input.files.cashStatus = [await file(books.status, "261014_자금현황표[KC].xlsx")];
  expect(await dailyCashTool.execute(input)).toMatchObject({ status: "failed", message: expect.stringContaining("기준일 2026-10-14와 일보 기준일 2026-10-13") });
});
it("carries sub-won interest fractions forward and reconciles them against whole-won KC balances", async () => {
  const { input, books, file } = await setup(); books.report.getWorksheet("261012")!.getCell("H10").value = 100000.27878; input.files.previousReport = [await file(books.report, "전일일보.xlsx")];
  const result = await confirm(input); expect(result.status, JSON.stringify(result.status === "failed" ? result : {})).toBe("completed");
  if (result.status !== "completed") return;
  const b = new ExcelJS.Workbook(); await b.xlsx.load(Buffer.from(result.file.bytes) as unknown as ExcelJS.Buffer); const s = b.getWorksheet("261013")!;
  expect(s.getCell("D10").value).toBe(100000.27878); expect(s.getCell("H10").result).toBe(109000.27878);
}, artifactTestTimeout);
it("prefills today, the previous report, the weekly plan and the report-date KC file from connected folders", () => {
  const wf = (name: string) => ({ sourceId: "s", relativePath: name, name });
  const files = ["261013_일일자금일보 .xlsx", "261014_일일자금일보.xlsx", "일일자금일보 샘플.xlsx", "일일자금일보 업무흐름.xlsx", "주간자금계획서_1002.xlsx", "주간자금계획서_1009.xlsx", "주간자금계획서_1016.xlsx", "261014_자금현황표[KC].xlsx", "261013_자금현황표[KC].xlsx"].map(wf);
  const suggested = dailyCashTool.suggest!(files, "2026-10-15");
  expect(suggested.values.workDate).toBe("2026-10-15");
  expect(suggested.files.previousReport.map((f) => f.name)).toEqual(["261013_일일자금일보 .xlsx"]);
  expect(suggested.files.weeklyPlans.map((f) => f.name)).toEqual(["주간자금계획서_1009.xlsx"]);
  expect(suggested.files.cashStatus.map((f) => f.name)).toEqual(["261014_자금현황표[KC].xlsx"]);
  expect(dailyCashTool.suggest!(files, "2026-10-19").files.weeklyPlans.map((f) => f.name)).toEqual(["주간자금계획서_1016.xlsx"]);
});
it("reads a truly empty cell as 0 but still asks for a formula without a saved result", async () => {
  const { input, books, file } = await setup(); const s = books.report.getWorksheet("261012")!;
  s.getCell("I30").value = null; input.files.previousReport = [await file(books.report, "전일일보.xlsx")];
  expect((await confirm(input)).status).toBe("completed");
  s.getCell("I30").value = { formula: "H30*1" } as ExcelJS.CellValue; input.files.previousReport = [await file(books.report, "전일일보.xlsx")];
  expect(await dailyCashTool.execute(input)).toMatchObject({ status: "needs_input", fields: [expect.objectContaining({ key: "cell_I30", type: "number" })] });
  input.values.cell_I30 = "0"; expect((await confirm(input)).status).toBe("completed");
}, artifactTestTimeout);
it("asks for actual execution, rather than treating weekly plans as actuals", async () => {
  const { input } = await setup(); delete input.values.actualEdits;
  const result = await dailyCashTool.execute(input); expect(result).toMatchObject({ status: "needs_input", fields: [expect.objectContaining({ key: "actualEdits", type: "movements", rows: [{ index: 1, direction: "in", description: "정기예금 만기 원금", party: "기업은행 테스트", amount: "10000" }, expect.objectContaining({ index: 2, direction: "out", amount: "1000" })] }), expect.objectContaining({ key: "planEdits", type: "movements", rows: [expect.objectContaining({ index: 1, direction: "out", amount: "2000" })] })] });
});
it("rejects duplicate weekly versions and an already existing target sheet", async () => {
  const { input, books, file } = await setup(); input.files.weeklyPlans.push(input.files.weeklyPlans[0]);
  expect(await dailyCashTool.execute(input)).toMatchObject({ status: "failed", message: expect.stringContaining("중복") });
  input.files.weeklyPlans.pop(); books.report.addWorksheet("261013"); input.files.previousReport = [await file(books.report, "전일일보.xlsx")];
  expect(await dailyCashTool.execute(input)).toMatchObject({ status: "failed", message: expect.stringContaining("이미") });
});
it("requires explicit values for missing formula caches and does not silently use zero", async () => {
  const { books, input, file } = await setup(); books.report.getWorksheet(1)!.getCell("H21").value = { formula: "D21+E21-G21" }; input.files.previousReport = [await file(books.report, "전일.xlsx")];
  expect(await dailyCashTool.execute(input)).toMatchObject({ status: "needs_input", fields: [expect.objectContaining({ key: "cell_H21", type: "number", label: expect.stringContaining("H21") })] });
});
it("stops when actual account cash differs from ledger or a term has not settled", async () => {
  const { books, input, file } = await setup(); const s = books.status.getWorksheet(1)!; s.getCell("O2").value = 108000; s.getCell("O4").value = 108000; input.files.cashStatus = [await file(books.status, "261013_자금현황표[KC].xlsx")];
  expect(await dailyCashTool.execute(input)).toMatchObject({ status: "needs_input", fields: expect.arrayContaining([expect.objectContaining({ key: "cashChanges" })]) });
});
it("requires corrections when planned executions do not reconcile the holding cash", async () => {
  const { input } = await setup(); input.values.actualEdits = '{"changes":[{"index":2,"amount":"2000"}]}';
  expect(await dailyCashTool.execute(input)).toMatchObject({ status: "needs_input", question: expect.stringContaining("실적 내역과 원화 계좌잔고") });
});
it("parses merged KC identifiers separately per currency and rejects incorrect totals", () => {
  const { status } = fixtureBooks(); const s = status.getWorksheet(1)!;
  expect(readCashStatus(status).total.toString()).toBe("109000"); s.getCell("O4").value = 1;
  expect(() => readCashStatus(status)).toThrow("환종별합계");
});
it("extracts both directions of holding cash, ignores other categories and totals", () => {
  const { weekly } = fixtureBooks(); const s = weekly.getWorksheet(1)!;
  const parsed = readWeekly(weekly, "wrong-filename-date.xlsx"); expect(parsed.movements.map((m) => m.amount.toString())).toEqual(["10000", "1000", "2000"]);
  s.getCell("C7").value = "사업현금"; expect(readWeekly(weekly, "weekly").movements).toHaveLength(2);
});
async function depositSetup() {
  const state = await setup(); const { books, input, file } = state;
  const p = books.report.getWorksheet(1)!;
  p.getCell("A52").value = p.getCell("A51").value; p.getCell("C52").value = p.getCell("C51").value; p.getCell("H52").value = 10000;
  const w = books.weekly.getWorksheet(1)!;
  for (let r = 7; r <= 13; r++) for (const c of ["B", "C", "D", "F", "G", "H", "I", "K", "L"]) w.getCell(`${c}${r}`).value = null;
  w.getCell("B7").value = new Date("2026-10-13T00:00:00Z");
  for (const r of [7, 9]) { w.getCell(`C${r}`).value = "사업예만"; w.getCell(`D${r}`).value = "정기예금만기(12개월/2.0%/251013~261013) 원금"; w.getCell(`F${r}`).value = "기업은행 테스트"; w.getCell(`G${r}`).value = 10000; }
  for (const r of [8, 10]) { w.getCell(`C${r}`).value = "사업현금"; w.getCell(`D${r}`).value = "정기예금만기(12개월/2.0%/251013~261013) 이자"; w.getCell(`F${r}`).value = "기업은행 테스트"; w.getCell(`G${r}`).value = 150; }
  w.getCell("H7").value = "사업예불"; w.getCell("I7").value = "정기예금 가입"; w.getCell("L7").value = 20000;
  w.getCell("C11").value = "사업현금"; w.getCell("D11").value = "사업부문 현금유입"; w.getCell("G11").value = 12345;
  w.getCell("H11").value = "지주현금"; w.getCell("I11").value = "소모품 지급"; w.getCell("L11").value = 1000;
  w.getCell("B12").value = new Date("2026-10-14T00:00:00Z"); w.getCell("H12").value = "지주현금"; w.getCell("I12").value = "익일 지급"; w.getCell("L12").value = 2000;
  w.getCell("B13").value = "지주-현금입금";
  const k = books.status.getWorksheet(1)!;
  for (const c of ["I", "J"]) k.getCell(`${c}2`).value = 0;
  for (const c of ["M", "N", "O"]) k.getCell(`${c}2`).value = 99000;
  k.addRow([4, "기업은행 테스트", "TERM-2", "정기예금2", "TERM-2", "KRW", 10000, 10000, 0, 0, 10000, 10000, 0, 0, 0, 0, "정기예금", "", new Date("2025-10-13T00:00:00Z"), new Date("2026-10-13T00:00:00Z")]);
  for (const [key, amount, maturity] of [["NEW-1", 12000, "2027-09-13"], ["NEW-2", 8000, "2027-10-13"]] as const) k.addRow([6, "우리은행 테스트", key, key, key, "KRW", 0, 0, amount, amount, 0, 0, amount, amount, amount, 0, "정기예금", "", new Date("2026-10-13T00:00:00Z"), new Date(`${maturity}T00:00:00Z`)]);
  for (const c of ["M", "N", "O"]) k.getCell(`${c}4`).value = 119000;
  input.files.previousReport = [await file(books.report, "전일.xlsx")]; input.files.weeklyPlans = [await file(books.weekly, "계획.xlsx")]; input.files.cashStatus = [await file(books.status, "261013_현황.xlsx")]; input.values.depositEdits = "확인";
  return state;
}
it("reads business-coded deposit principal and interest separately, excluding division summaries and daily totals", async () => {
  const { books } = await depositSetup(); const w = books.weekly.getWorksheet(1)!;
  w.getCell("H8").value = "사업현금"; w.getCell("I8").value = "사업부문 현금유출"; w.getCell("L8").value = 9000; w.getCell("K8").value = { error: "#N/A" };
  w.getCell("H9").value = "지주현금"; w.getCell("I9").value = "일계";
  w.getCell("C11").value = "지주현금"; w.getCell("D11").value = "사업부문 현급유입";
  const parsed = readWeekly(books.weekly, "weekly");
  expect(parsed.movements.map((m) => m.amount.toNumber())).toEqual([1000, 2000]);
  expect(parsed.deposits.map((m) => [m.direction, m.amount.toNumber()])).toEqual([["in", 10000], ["out", 20000], ["in", 150], ["in", 10000], ["in", 150]]);
  expect(parsed.deposits.every((m) => m.date === "2026-10-13" && m.source.includes("세부계획"))).toBe(true);
});
it("redeems duplicate deposits and allocates a pooled subscription to new KC accounts without adding interest to principal or holding cash", async () => {
  const { books, input, file } = await depositSetup();
  const result = await confirm(input); expect(result.status, JSON.stringify(result.status === "completed" ? {} : result)).toBe("completed"); if (result.status !== "completed") return;
  const b = new ExcelJS.Workbook(); await b.xlsx.load(Buffer.from(result.file.bytes) as unknown as ExcelJS.Buffer); const s = b.getWorksheet("261013")!;
  for (const r of [51, 52]) { expect(s.getCell(`G${r}`).value).toBe(10000); expect(s.getCell(`H${r}`).result).toBe(0); expect(s.getRow(r).hidden).toBe(false); }
  for (const [r, amount, due] of [[53, 12000, "270913"], [54, 8000, "271013"]] as const) {
    expect(s.getCell(`D${r}`).value).toBe(0); expect(s.getCell(`E${r}`).value).toBe(amount); expect(s.getCell(`H${r}`).result).toBe(amount);
    expect(s.getCell(`C${r}`).value).toBe("우리은행 테스트"); expect(s.getCell(`A${r}`).value).toBe(`261013~${due}`); expect(s.getRow(r).hidden).toBe(false);
    expect(b.getWorksheet("261012")!.getCell(`C${r}`).value).toBeNull();
  }
  expect(s.getCell("E98").result).toBe(20000); expect(s.getCell("G98").result).toBe(20000); expect(s.getCell("H98").result).toBe(20000);
  expect(s.getCell("H17").result).toBe(99000); expect(s.getCell("D156").result).toBe(0); expect(s.getCell("G248").value).toBe(119000);
  expect(result.externalData?.deposits).toHaveLength(5); expect(result.externalData?.newDeposits).toHaveLength(2);
  expect(layout(s).krwTermSum).toBe(98); expect(priorAmounts(s, {}).values.H53.toNumber()).toBe(12000);
  const k = books.status.getWorksheet(1)!;
  for (const [c, value] of [["G", 99000], ["H", 99000], ["K", 2000], ["L", 2000], ["M", 97000], ["N", 97000], ["O", 97000]] as const) k.getCell(`${c}2`).value = value;
  for (const r of [3, 5]) for (const c of ["G", "H", "K", "L"]) k.getCell(`${c}${r}`).value = 0;
  for (const [r, amount] of [[6, 12000], [7, 8000]]) { for (const c of ["G", "H"]) k.getCell(`${c}${r}`).value = amount; for (const c of ["I", "J"]) k.getCell(`${c}${r}`).value = 0; }
  for (const c of ["M", "N", "O"]) k.getCell(`${c}4`).value = 117000;
  input.files.previousReport = [await file(b, "전일.xlsx")]; input.files.cashStatus = [await file(books.status, "261014_현황.xlsx")]; input.values.workDate = "2026-10-15"; input.values.noPlanDates = "2026-10-14,2026-10-15";
  const next = await confirm(input); expect(next.status, JSON.stringify(next.status === "completed" ? {} : next)).toBe("completed"); if (next.status !== "completed") return;
  const nextBook = new ExcelJS.Workbook(); await nextBook.xlsx.load(Buffer.from(next.file.bytes) as unknown as ExcelJS.Buffer); const nextSheet = nextBook.getWorksheet("261014")!;
  expect(nextSheet.getCell("D53").value).toBe(12000); expect(nextSheet.getCell("E98").result).toBe(0); expect(nextSheet.getCell("G98").result).toBe(0); expect(nextSheet.getCell("H98").result).toBe(20000);
}, artifactTestTimeout);
it("requires deposit execution confirmation and rejects principal mismatches and unsupported deposit edits", async () => {
  const { input } = await depositSetup(); delete input.values.depositEdits;
  expect(await dailyCashTool.execute(input)).toMatchObject({ status: "needs_input", fields: expect.arrayContaining([expect.objectContaining({ key: "depositEdits", type: "movements" })]) });
  input.values.depositEdits = '{"changes":[{"index":2,"amount":20300}]}';
  expect(await dailyCashTool.execute(input)).toMatchObject({ status: "needs_input", question: expect.stringContaining("맞지 않는 원금 300원") });
  input.values.depositEdits = '{"changes":[{"index":1,"amount":0}]}';
  expect(await dailyCashTool.execute(input)).toMatchObject({ status: "needs_input", question: expect.stringContaining("만기 감소 10000원") });
  input.values.depositEdits = '{"changes":[{"index":1,"amount":10000,"party":"하나은행 테스트"}]}';
  expect(await dailyCashTool.execute(input)).toMatchObject({ status: "needs_input", question: expect.stringContaining("맞지 않는 원금 10000원") });
  input.values.depositEdits = '{"add":[{"direction":"in","description":"사업부문 현금유입","amount":100}]}';
  expect(await dailyCashTool.execute(input)).toMatchObject({ status: "needs_input", question: expect.stringContaining("적요만 허용") });
});
it("includes confirmed deposit interest in final review and invalidates approval when it changes", async () => {
  const { input } = await depositSetup(); const first = await dailyCashTool.execute(input); if (first.status !== "needs_input") throw new Error("review");
  for (const title of ["최종 확인", "계좌 연결", "계획 대비 실적 차이", "정기예금 집행", "신규 가입", "만기", "원화 대사 및 환율"]) expect(first.question).toContain(`### ${title}\n\n`);
  expect(first.question).toContain("- **입금 150원**");
  expect(first.question).toContain("신한\\_입출금\\_지주\\_원화");
  input.values.review = first.fields.find((f) => f.key === "review")!.confirm!; input.checkpoint = first.checkpoint!;
  input.values.depositEdits = '{"changes":[{"index":3,"amount":175}]}';
  const updated = await dailyCashTool.execute(input); expect(updated.status).toBe("needs_input"); if (updated.status !== "needs_input") return;
  expect(updated.question).toContain("175원"); expect(updated.fields.find((f) => f.key === "review")!.confirm).not.toBe(input.values.review);
});
it("validates a new deposit's dates and opening amount, and never overwrites an occupied row", async () => {
  const { books } = await depositSetup(); const s = books.report.getWorksheet(1)!; const previous = priorAmounts(s, {}).values;
  const a = readCashStatus(books.status).accounts.find((a) => a.key === "NEW-1:KRW")!;
  const bind = (account = a, explicit = {}) => bindAccounts(s, [account], previous, explicit, "2026-10-13");
  expect(bind().bindings.get(a.key)).toBe("H53");
  for (const account of [{ ...a, bank: "" }, { ...a, start: undefined }, { ...a, maturity: undefined }, { ...a, opening: new Money(1) }]) expect(bind(account).bindings.has(a.key)).toBe(false);
  expect(() => bind(a, { [a.key]: "H51" })).toThrow("만기일/예금 항목");
  s.getCell("A53").value = "예약 행"; expect(bind().bindings.get(a.key)).toBe("H54");
  for (const row of layout(s).krwTermRows.filter((r) => r > 52)) s.getCell(`A${row}`).value = "예약 행";
  expect(bind().unresolved.join("\n")).toContain("빈 예금 행이 없습니다");
});
it("supports changed amounts, omitted and unplanned transactions without float arithmetic", () => {
  const rows = [{ date: "2026-10-13", direction: "out" as const, description: "test", party: "test", amount: new Money("0.1"), source: "fixture" }];
  expect(applyEdits(rows, '{"changes":[{"index":1,"amount":0}],"add":[{"direction":"in","description":"추가","amount":"0.2"}]}', "2026-10-13")[0].amount.plus("0.1").toString()).toBe("0.3");
  expect(() => applyEdits(rows, '{"changes":[{"index":2,"amount":1}]}', "2026-10-13")).toThrow();
});
it("parses Hana base rates at the correct column and converts JPY per 100 units", () => {
  const html = '<p class="txtRateBox">기준일 : <strong>2026년10월13일</strong> 고시일시 : 2026년10월14일 07시 (1206회차)</p><th>매매 기준율</th>' + [["USD", "1400"], ["JPY (100)", "950"], ["CNY", "200"]].map(([c, rate]) => `<tr>${[c, "999", "1", "999", "1", "999", "999", "999", rate, "1", "1"].map((v) => `<td>${v}</td>`).join("")}</tr>`).join("");
  expect(parseHana(html, "2026-10-13")).toMatchObject({ date: "2026-10-13", round: "1206", perUnit: { USD: "1400", JPY: "9.5", CNY: "200" } });
  expect(() => parseHana(html.replace("JPY (100)", "JPY"), "2026-10-13")).toThrow("단위");
});
it("keeps JPY and CNY separate and uses KC foreign balances with per-unit FX rates", async () => {
  const { books, input, file } = await setup(); const p = books.report.getWorksheet(1)!; p.getCell("H23").value = 100; p.getCell("I23").value = 900; p.getCell("H26").value = 200; p.getCell("I26").value = 40000;
  const k = books.status.getWorksheet(1)!;
  k.addRow([4, "테스트은행", "FXJPY", "JPY 테스트", "FXJPY", "JPY", 900, 100, 0, 0, 0, 0, 900, 100, 100, 0, "보통예금"]);
  k.addRow([5, "테스트은행", "FXCNY", "CNY 테스트", "FXCNY", "CNY", 40000, 200, 0, 0, 0, 0, 40000, 200, 200, 0, "보통예금"]);
  input.files.previousReport = [await file(books.report, "전일.xlsx")]; input.files.cashStatus = [await file(books.status, "261013_현황.xlsx")]; input.values.accountBindings = '{"FXJPY:JPY":"H23","FXCNY:CNY":"H26"}';
  const result = await confirm(input); expect(result.status, JSON.stringify(result.status !== "completed" && result)).toBe("completed");
  if (result.status !== "completed") return;
  const b = new ExcelJS.Workbook(); await b.xlsx.load(Buffer.from(result.file.bytes) as unknown as ExcelJS.Buffer); const s = b.getWorksheet("261013")!;
  expect(s.getCell("H25").result).toBe(100); expect(s.getCell("H27").result).toBe(200); expect(s.getCell("F242").value).toBe(40950);
}, artifactTestTimeout);
it("never combines a months-old daily report with a current KC snapshot", async () => {
  const { books, input, file } = await setup(); books.report.getWorksheet(1)!.name = "260528"; input.files.previousReport = [await file(books.report, "old.xlsx")];
  expect(await dailyCashTool.execute(input)).toMatchObject({ status: "failed", message: expect.stringContaining("너무 오래") });
});
it("re-asks for confirmation when actual or next-day plan changes after review", async () => {
  const { input } = await setup(); const result = await dailyCashTool.execute(input); if (result.status !== "needs_input") throw new Error("review");
  const codeOf = (fields: typeof result.fields) => fields.find((field) => field.key === "review")!.confirm!;
  input.values.review = codeOf(result.fields); input.checkpoint = result.checkpoint!;
  input.values.planEdits = '{"changes":[{"index":1,"amount":3000}]}';
  const updated = await dailyCashTool.execute(input); expect(updated.status).toBe("needs_input"); if (updated.status === "needs_input") expect(codeOf(updated.fields)).not.toBe(input.values.review);
});

it("wraps a long execution description and grows the row so the PNG does not clip it", () => {
  const { report } = fixtureBooks(); const s = report.getWorksheet("261012")!;
  const short = s.getCell("F131"); const long = s.getCell("F132");
  fitDescription(s, short, "익일 지급 계획 / 가상상사");
  fitDescription(s, long, "협력사 10월 기성 대금 및 부가가치세 정산 지급 (제2공장 설비 증설분 포함) / 가상건설 주식회사");
  expect(short.alignment.wrapText).toBe(true); expect(s.getRow(131).height).toBe(22);
  // F:G is 15+23 chars wide (268 px of 9pt text ≈ 22 CJK glyphs per line) → 3 lines ≥ 38pt, well above the template's 22pt.
  expect(long.alignment.wrapText).toBe(true); expect(s.getRow(132).height).toBeGreaterThanOrEqual(38);
});

it("falls back to manually entered rates after a failed retry and records them as manual", async () => {
  const { input } = await setup(); vi.mocked(fetchHana).mockClear().mockRejectedValueOnce(new Error("화면 변경")).mockRejectedValueOnce(new Error("화면 변경"));
  const first = await dailyCashTool.execute(input); expect(first).toMatchObject({ status: "needs_input", fields: [expect.objectContaining({ key: "retryRates", confirm: "확인" })] });
  input.values.retryRates = "확인";
  const second = await dailyCashTool.execute(input); expect(second).toMatchObject({ status: "needs_input", fields: expect.arrayContaining([expect.objectContaining({ key: "manualUSD", type: "number" }), expect.objectContaining({ key: "manualJPY100" })]) });
  Object.assign(input.values, { manualRateDate: "2026-10-13", manualRateRound: "8", manualUSD: "1402.5", manualJPY100: "950.12", manualCNY: "199.9" });
  const review = await dailyCashTool.execute(input); expect(review.status).toBe("needs_input"); if (review.status !== "needs_input") return;
  expect(review.fields.map((field) => field.key)).toContain("review"); expect(review.question).toContain("USD 1402.5"); expect(review.question).toContain("JPY(1엔) 9.5012");
  expect(review.checkpoint).toMatchObject({ rates: { source: expect.stringContaining("수동"), round: "8", date: "2026-10-13", perUnit: { USD: "1402.5", JPY: "9.5012", CNY: "199.9" } } });
  expect(fetchHana).toHaveBeenCalledTimes(2);
});
