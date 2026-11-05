// @vitest-environment node
import { expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import sharp from "sharp";
import JSZip from "jszip";
import { SelectiveWorkbook } from "../work/selectiveWorkbook.ts";
import { dailyCashTool, applyEdits } from "./dailyCash.ts";
import { bindAccounts, layout, priorAmounts } from "./dailyCash/report.ts";
import { renderSheet } from "./dailyCash/image.ts";
import { annualReportFixture, fixtureBooks, fixtureErpResponse } from "./dailyCash/fixtures.ts";
import { createErpSnapshot, fetchErpCashStatus } from "./dailyCash/erp.ts";
import { readCashStatus } from "./dailyCash/cashStatus.ts";
import { readWeekly } from "./dailyCash/weekly.ts";
import { fetchHana, parseHana } from "./dailyCash/hana.ts";
import { Money, previousBusinessDay } from "./dailyCash/values.ts";
import type { BusinessTool } from "./contracts.ts";
vi.mock("./dailyCash/hana.ts", async (original) => ({ ...await original<typeof import("./dailyCash/hana.ts")>(), fetchHana: vi.fn(async (day: string) => ({ date: day, requestedDate: day, round: "10", publishedAt: "테스트 고시", source: "fixture-only", fetchedAt: "2026-10-14T00:00:00Z", responseHash: "fixture", perUnit: { USD: "1400", JPY: "9.5", CNY: "200" } })) }));
vi.mock("./dailyCash/erp.ts", async (original) => ({ ...await original<typeof import("./dailyCash/erp.ts")>(), fetchErpCashStatus: vi.fn() }));
vi.mock("./dailyCash/image.ts", () => ({ renderSheet: vi.fn(async (bytes: Uint8Array, name: string) => ({ bytes, engine: "Excel" as const, fallbackReason: undefined, sheet: (await (await SelectiveWorkbook.open(bytes)).loadSheet(name)).getWorksheet(name)!, image: await sharp({ create: { width: 1, height: 1, channels: 4, background: "white" } }).png().toBuffer() })) }));
async function setup() {
  const books = fixtureBooks(); const file = async (book: ExcelJS.Workbook, name: string) => ({ bytes: Buffer.from(await book.xlsx.writeBuffer()), name, fingerprint: name });
  const input: Parameters<BusinessTool["execute"]>[0] = { values: { workDate: "2026-10-14", actualEdits: "확인", planEdits: "확인" }, files: { previousReport: [await file(books.report, "전일일보.xlsx")], weeklyPlans: [await file(books.weekly, "계획.xlsx")] }, checkpoint: {}, signal: new AbortController().signal };
  vi.mocked(fetchErpCashStatus).mockReset().mockImplementation(async (workDate) => createErpSnapshot(fixtureErpResponse(books.status), workDate));
  return { books, input, file };
}
// Workbook generation needs more time on shared Windows CI runners; native Excel is mocked here.
const artifactTestTimeout = 30_000;
it("asks only for unresolved account locations and accepts the form's existing mapping contract", async () => {
  const { input, books } = await setup();
  const account = books.status.getWorksheet(1)!.getRow(2);
  account.getCell(3).value = "001234"; account.getCell(4).value = "기업_입출금_원화";

  const result = await dailyCashTool.execute(input);
  expect(result).toMatchObject({ status: "needs_input", fields: [{ key: "accountBindings", type: "text", accountRows: [{ key: "001234:KRW", name: "기업_입출금_원화", currency: "KRW", balance: "109000" }] }] });
  if (result.status !== "needs_input") return;
  expect(result.question).toContain("261012"); expect(result.question).toContain("행 번호"); expect(result.question).not.toContain("JSON");
  input.values.accountBindings = '{"001234:KRW":"H10"}';
  expect(await dailyCashTool.execute(input)).toMatchObject({ status: "needs_input", fields: expect.arrayContaining([expect.objectContaining({ key: "review" })]) });
  input.values.accountBindings = '{"001234:KRW":"H23"}';
  expect(await dailyCashTool.execute(input)).toMatchObject({ status: "failed", message: expect.stringContaining("통화/정기예금") });
  input.values.accountBindings = '{"001234:KRW":"H10","TEST-TERM:KRW":"H10"}';
  expect(await dailyCashTool.execute(input)).toMatchObject({ status: "failed", message: expect.stringContaining("중복") });
  input.values.accountBindings = "invalid";
  const retry = await dailyCashTool.execute(input);
  expect(retry).toMatchObject({ status: "needs_input", fields: [expect.objectContaining({ accountRows: expect.any(Array) })] });
  if (retry.status === "needs_input") expect(retry.question).not.toContain("JSON");
});

it("asks for corrected source files when a report balance has no KC account to connect", async () => {
  const { input, books, file } = await setup();
  books.report.getWorksheet(1)!.getCell("H9").value = 100;
  input.files.previousReport = [await file(books.report, "전일.xlsx")];
  expect(await dailyCashTool.execute(input)).toMatchObject({ status: "failed", message: expect.stringContaining("누락된 계좌") });
});

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
  expect(s.getCell("J23").result).toBe(0); expect(s.pageSetup.printArea).toBe("A1:P249");
  expect(s.pageSetup).toMatchObject({ fitToPage: true, fitToWidth: 1, fitToHeight: 1 });
  expect(Buffer.from(result.image!.bytes).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(renderSheet).toHaveBeenCalledWith(expect.any(Uint8Array), "261013", expect.any(Array), input.signal, expect.any(Array));
  for (const row of [238, 239, 249]) expect(s.getRow(row).hidden, `row ${row}`).toBe(false);
  expect(result.externalData?.matured).toHaveLength(1);
}, artifactTestTimeout);
it("rejects a cached ERP period from a different report date", async () => {
  const { input, books } = await setup();
  input.checkpoint.erpCash = createErpSnapshot(fixtureErpResponse(books.status), "2026-10-15");
  expect(await dailyCashTool.execute(input)).toMatchObject({ status: "failed", message: expect.stringContaining("ERP 조회 기간과 일보 기준일") });
  expect(fetchErpCashStatus).not.toHaveBeenCalled();
});

it("preserves a year of historical sheets, including distant used cells, when appending the next report", async () => {
  const { input, books, file } = await setup();
  for (let day = 0; day < 365; day++) {
    const name = new Date(Date.UTC(2025, 0, day + 1)).toISOString().slice(2, 10).replaceAll("-", "");
    books.report.addWorksheet(name).getCell("A1").value = `history ${name}`;
  }
  const archive = books.report.getWorksheet("250101")!;
  archive.getCell(100001, 501).value = "historical note";
  input.files.previousReport = [await file(books.report, "연간일보.xlsx")];
  const result = await confirm(input);
  expect(result.status, JSON.stringify(result.status === "completed" ? {} : result)).toBe("completed");
  if (result.status !== "completed") return;
  const output = new ExcelJS.Workbook(); await output.xlsx.load(Buffer.from(result.file.bytes) as unknown as ExcelJS.Buffer);
  expect(output.worksheets.map((sheet) => sheet.name)).toEqual([...books.report.worksheets.map((sheet) => sheet.name), "261013"]);
  for (const sheet of books.report.worksheets.slice(1)) expect(output.getWorksheet(sheet.name)!.getCell("A1").value).toBe(sheet.getCell("A1").value);
  expect(output.getWorksheet("250101")!.getCell(100001, 501).value).toBe("historical note");
  expect(output.getWorksheet("261012")!.getCell("H10").value).toBe(100000);
  expect(output.getWorksheet("261013")!.getCell("H10").result).toBe(109000);
}, artifactTestTimeout);
it("carries sub-won interest fractions forward and reconciles them against whole-won KC balances", async () => {
  const { input, books, file } = await setup(); books.report.getWorksheet("261012")!.getCell("H10").value = 100000.27878; input.files.previousReport = [await file(books.report, "전일일보.xlsx")];
  const result = await confirm(input); expect(result.status, JSON.stringify(result.status === "failed" ? result : {})).toBe("completed");
  if (result.status !== "completed") return;
  const b = new ExcelJS.Workbook(); await b.xlsx.load(Buffer.from(result.file.bytes) as unknown as ExcelJS.Buffer); const s = b.getWorksheet("261013")!;
  expect(s.getCell("D10").value).toBe(100000.27878); expect(s.getCell("H10").result).toBe(109000.27878);
}, artifactTestTimeout);
it("defaults the work date to today and computes the report date as the previous business day", () => {
  expect(dailyCashTool.defaults!("2026-10-15")).toEqual({ workDate: "2026-10-15" });
  expect(["2026-10-19", "2026-10-18", "2026-10-17", "2026-10-14"].map(previousBusinessDay)).toEqual(["2026-10-16", "2026-10-16", "2026-10-16", "2026-10-13"]);
  // 공휴일: 한글날(10/9 금) 다음 월요일은 10/8, 추석 연휴(9/24~26) 다음 월요일은 9/23, 대체공휴일(10/5 월) 다음 날은 10/2.
  expect(["2026-10-12", "2026-09-28", "2026-10-06"].map(previousBusinessDay)).toEqual(["2026-10-08", "2026-09-23", "2026-10-02"]);
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
  const { books, input } = await setup(); const s = books.status.getWorksheet(1)!; s.getCell("O2").value = 108000; s.getCell("O4").value = 108000;
  expect(await dailyCashTool.execute(input)).toMatchObject({ status: "needs_input", fields: expect.arrayContaining([expect.objectContaining({ key: "cashChanges" }), expect.objectContaining({ key: "actualEdits", type: "movements" })]) });
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
  input.files.previousReport = [await file(books.report, "전일.xlsx")]; input.files.weeklyPlans = [await file(books.weekly, "계획.xlsx")]; input.values.depositEdits = "확인";
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
  input.files.previousReport = [await file(b, "전일.xlsx")]; input.values.workDate = "2026-10-15"; input.values.noPlanDates = "2026-10-14,2026-10-15";
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
  input.files.previousReport = [await file(books.report, "전일.xlsx")]; input.values.accountBindings = '{"FXJPY:JPY":"H23","FXCNY:CNY":"H26"}';
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

it("preserves unmerged overflow text, merged edge styles and template checks at arbitrary addresses", async () => {
  const { books, input, file } = await setup(); const source = books.report.getWorksheet("261012")!;
  source.unMergeCells("F131:G131"); source.getCell("F131").alignment = { horizontal: "left", wrapText: false };
  source.getRow(131).height = 19;
  source.mergeCellsWithoutStyle("A8:B8"); source.mergeCellsWithoutStyle("E8:F8");
  for (const address of ["B8", "F8"]) source.getCell(address).border = { right: { style: "double", color: { argb: "FF123456" } } };
  const historic = books.report.addWorksheet("261009");
  historic.model = { ...structuredClone(source.model), id: historic.id, name: historic.name };
  source.getCell("D243").value = { formula: "D130='261009'!H130" };
  source.getCell("Q240").value = { formula: "SUM(H10:H13)", result: 100000 };
  input.files.previousReport = [await file(books.report, "template.xlsx")];
  input.values.planEdits = JSON.stringify({ changes: [{ index: 1, amount: 2000, description: "협력사 10월 기성 대금 및 부가가치세 정산 지급 (제2공장 설비 증설분 포함)" }] });
  const result = await confirm(input); if (result.status !== "completed") throw new Error(JSON.stringify(result));
  const output = (await (await SelectiveWorkbook.open(result.file.bytes)).loadSheet("261013")).getWorksheet("261013")!;
  expect(output.getCell("F131").isMerged).toBe(false);
  expect(output.getCell("F131").alignment.wrapText).not.toBe(true);
  expect(output.getRow(131).height).toBe(19);
  for (const address of ["B8", "F8"]) expect(output.getCell(address).border).toEqual(source.getCell(address).border);
  expect(output.getCell("D243").formula).toBe("D130='261012'!D237");
  expect(output.getCell("Q240").formula).toBe("SUM(H10:H13)");
  expect(output.pageSetup.printArea).toBe("A1:Q249");
}, artifactTestTimeout);

it("keeps the template's prior-sheet carry-over formulas and the next-day opening formula", async () => {
  const { books, input, file } = await setup(); const source = books.report.getWorksheet("261012")!;
  for (const row of [10, 21]) source.getCell(`D${row}`).value = { formula: `'261009'!H${row}`, result: 0 };
  source.getCell("D13").value = { formula: "'261009'!H12", result: 0 };
  source.getCell("H130").value = { formula: "$D$237", result: 0 };
  input.files.previousReport = [await file(books.report, "carry.xlsx")];
  const result = await confirm(input); if (result.status !== "completed") throw new Error(JSON.stringify(result));
  const output = (await (await SelectiveWorkbook.open(result.file.bytes)).loadSheet("261013")).getWorksheet("261013")!;
  expect(output.getCell("D10").value).toEqual({ formula: "'261012'!H10", result: 100000 });
  expect(output.getCell("D21").formula).toBe("'261012'!H21");
  expect(output.getCell("D13").formula).toBeUndefined();
  expect(output.getCell("H130").formula).toBe("D237");
  expect(output.getCell("H130").result).toBe(output.getCell("H17").result);
}, artifactTestTimeout);

it("preserves every cell style, including all blank merged children, and every original row height after saving", async () => {
  const { books, input, file } = await setup();
  const source = books.report.getWorksheet("261012")!;
  source.mergeCellsWithoutStyle("Q253:S255");
  for (let row = 253; row <= 255; row++) for (let col = 17; col <= 19; col++) {
    source.getCell(row, col).style = {
      border: { left: { style: "double", color: { argb: "FF123456" } }, bottom: { style: "dashed" } },
      font: { name: "Arial", size: col, bold: row === 254, italic: col === 18, color: { argb: "FF654321" } },
      alignment: { horizontal: "right", vertical: "middle", wrapText: row === 253, textRotation: col - 17 },
      numFmt: `0.${"0".repeat(row - 252)}`,
      fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEDDCC" } },
    };
  }
  source.getCell("T260").font = { name: "Arial", size: 18, strike: true };
  source.getRow(260).height = 29;
  source.getCell("M19").alignment = { horizontal: "left", wrapText: false };
  source.getRow(19).height = 17;
  input.files.previousReport = [await file(books.report, "styles.xlsx")];
  const original = (await (await SelectiveWorkbook.open(input.files.previousReport[0].bytes)).loadSheet("261012")).getWorksheet("261012")!;
  const result = await confirm(input); if (result.status !== "completed") throw new Error(JSON.stringify(result));
  const output = (await (await SelectiveWorkbook.open(result.file.bytes)).loadSheet("261013")).getWorksheet("261013")!;
  expect(output.model.merges).toEqual(original.model.merges);
  original.eachRow({ includeEmpty: true }, (row) => {
    expect(output.getRow(row.number).height, `row ${row.number}`).toBe(original.getRow(row.number).height);
    row.eachCell({ includeEmpty: true }, (cell) => expect(output.getCell(cell.address).style, cell.address).toEqual(cell.style));
  });
  for (let row = 253; row <= 255; row++) for (let col = 17; col <= 19; col++) {
    const cell = output.getCell(row, col);
    expect(cell.isMerged).toBe(true);
    expect(cell.value).toBeNull();
    expect(cell.font.size).toBe(col);
  }
}, artifactTestTimeout);

it("returns no completed artifacts if Excel export fails", async () => {
  const { input } = await setup();
  vi.mocked(renderSheet).mockRejectedValueOnce(new Error("Excel 출력 실패"));
  expect(await confirm(input)).toEqual({ status: "failed", message: "Excel 출력 실패" });
});

it("discloses LibreOffice fallback in the result and audit", async () => {
  const { input } = await setup();
  vi.mocked(renderSheet).mockImplementationOnce(async (bytes, name) => ({
    bytes, sheet: (await (await SelectiveWorkbook.open(bytes)).loadSheet(name)).getWorksheet(name)!,
    image: await sharp({ create: { width: 1, height: 1, channels: 4, background: "white" } }).png().toBuffer(),
    engine: "LibreOffice", fallbackReason: "Excel view-only",
  }));
  expect(await confirm(input)).toMatchObject({
    status: "completed", summary: expect.stringContaining("LibreOffice (Excel 출력 실패로 자동 전환)"),
    externalData: { outputEngine: "LibreOffice", fallbackReason: "Excel view-only" },
  });
});

it.each(["G248", "D237", "H10"])("rejects an Excel-calculated financial mismatch at %s", async (address) => {
  const { input } = await setup();
  vi.mocked(renderSheet).mockImplementationOnce(async (bytes, name) => {
    const sheet = (await (await SelectiveWorkbook.open(bytes)).loadSheet(name)).getWorksheet(name)!;
    sheet.getCell(address).value = 999;
    return { bytes, sheet, image: Buffer.alloc(0), engine: "Excel", fallbackReason: undefined };
  });
  expect(await confirm(input)).toMatchObject({ status: "failed", message: expect.stringContaining("Excel 재계산 후") });
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


it("calculates and saves the next daily cash report from 366 full report sheets while parsing only the required prior sheet", async () => {
  const { input } = await setup(); const annual = await annualReportFixture();
  input.files.previousReport = [{ bytes: annual, name: "연간일보.xlsx", fingerprint: "annual" }];
  const parsed: string[][] = []; const load = SelectiveWorkbook.prototype.loadSheet;
  const spy = vi.spyOn(SelectiveWorkbook.prototype, "loadSheet").mockImplementation(async function (this: SelectiveWorkbook, name: string) {
    const book = await load.call(this, name); parsed.push(book.worksheets.map((sheet) => sheet.name)); return book;
  });
  const started = performance.now();
  try {
    const result = await confirm(input);
    expect(result.status, JSON.stringify(result.status !== "completed" && result)).toBe("completed");
    if (result.status !== "completed") return;
    expect(parsed).toEqual([["261012"], ["261012"], ["261013"]]);
    expect(result.validationSheet).toBe("261013");
    const output = await SelectiveWorkbook.open(result.file.bytes);
    expect(output.sheetNames).toHaveLength(367);
    const latest = await output.loadSheet(result.validationSheet!);
    expect(latest.worksheets).toHaveLength(1);
    expect(latest.getWorksheet("261013")!.getCell("H10").result).toBe(109000);
    expect(latest.getWorksheet("261013")!.pageSetup.printArea).toBe("A1:P249");
    const before = await JSZip.loadAsync(annual); const after = await JSZip.loadAsync(result.file.bytes);
    for (const path of Object.keys(before.files).filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/.test(path))) {
      expect(await after.file(path)!.async("string"), path).toBe(await before.file(path)!.async("string"));
    }
    console.info(`Annual Daily Cash: 366 input → 367 output sheets; 1 prior sheet parsed per run; ${annual.length} input bytes; ${Math.round(performance.now() - started)} ms including review, save, validation and archive comparison`);
  } finally { spy.mockRestore(); }
}, artifactTestTimeout);

it("reconciles labeled cash totals and keeps invalid answers in the same form", async () => {
  const { books, input } = await setup();
  const s = books.status.getWorksheet(1)!; s.getCell("O2").value = 108000; s.getCell("O4").value = 108000;

  for (const value of [undefined, "invalid", '{"unknown:KRW":{"incoming":"0","outgoing":"0"}}', '{"140013557434:KRW":{"incoming":"-1","outgoing":"0"}}']) {
    if (value === undefined) delete input.values.cashChanges; else input.values.cashChanges = value;
    const result = await dailyCashTool.execute(input);
    expect(result).toMatchObject({ status: "needs_input", fields: expect.arrayContaining([expect.objectContaining({ key: "cashChanges", cashRows: expect.arrayContaining([expect.objectContaining({ key: "140013557434:KRW", opening: "100000", balance: "108000" })]) })]) });
    if (result.status === "needs_input") expect(result.question).not.toMatch(/JSON|incoming|outgoing/);
  }
  input.values.cashChanges = '{"140013557434:KRW":{"incoming":"10000","outgoing":"2000"}}';
  input.values.actualEdits = '{"changes":[{"index":2,"amount":"2000"}]}';
  expect(await dailyCashTool.execute(input)).toMatchObject({ status: "needs_input", fields: expect.arrayContaining([expect.objectContaining({ key: "review" })]) });
});

it("reasks invalid previous amounts as numeric fields and explicitly resets unreadable legacy answers", async () => {
  const { input } = await setup();
  for (const value of ["bad", ""]) {
    input.values.cell_H21 = value;
    expect(await dailyCashTool.execute(input)).toMatchObject({ status: "needs_input", fields: [{ key: "cell_H21", type: "number", required: true, label: expect.stringContaining("H21") }] });
  }
  delete input.values.cell_H21;
  input.values.previousValues = "invalid";
  expect(await dailyCashTool.execute(input)).toMatchObject({ status: "needs_input", fields: [{ key: "previousValues", label: expect.any(String), confirm: "{}" }] });
  input.values.previousValues = "{}";
  expect(await dailyCashTool.execute(input)).toMatchObject({ status: "needs_input", fields: expect.arrayContaining([expect.objectContaining({ key: "review" })]) });
});

it("asks for an Excel recalculation instead of bulk JSON when many cached amounts are missing", async () => {
  const { books, input, file } = await setup();
  const sheet = books.report.getWorksheet(1)!;
  for (const row of [9, 10, 11, 12, 13, 15, 21, 23, 24, 26, 28, 30, ...layout(sheet).termRows]) sheet.getCell(`H${row}`).value = { formula: "0" };
  input.files.previousReport = [await file(books.report, "전일.xlsx")];
  expect(await dailyCashTool.execute(input)).toMatchObject({ status: "failed", message: expect.stringContaining("Excel에서 열어 수식을 계산하고 저장") });
});
