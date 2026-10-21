// @vitest-environment node
import ExcelJS from "exceljs";
import { expect, it } from "vitest";
import { BANK_ROWS, OPERATING_ROWS, STATEMENTS, buildBankStatement } from "../../scripts/bank-fixture.ts";
import { bankDailyTool } from "./bankDaily.ts";

const statements = () => Promise.all(STATEMENTS.map(async ({ file, account, rows }) => ({ name: file, bytes: await buildBankStatement(rows, account) })));
const run = async (transactions: { name: string; bytes: Buffer }[], businessDate = "2026-10-14") =>
  bankDailyTool.execute({ values: { businessDate }, files: { transactions: transactions.map((file, i) => ({ ...file, fingerprint: `f${i}` })) }, checkpoint: {}, signal: new AbortController().signal });
const values = (sheet: ExcelJS.Worksheet) => sheet.getSheetValues().slice(2).map((row) => (row as ExcelJS.CellValue[] | undefined)?.slice(1) ?? []);

it("summarizes each account file and the total with hand-checked numbers", async () => {
  const result = await run(await statements());
  if (result.status !== "completed") throw new Error(JSON.stringify(result));
  expect(result.checks.every((check) => check.passed)).toBe(true);
  const book = new ExcelJS.Workbook(); await book.xlsx.load(Buffer.from(result.file.bytes) as unknown as ExcelJS.Buffer);
  expect(values(book.getWorksheet("요약")!).slice(0, 3)).toEqual([
    ["기업은행_법인주거래", 151962550, 16518372, 53134030, -36615658, 115346892],
    ["국민은행_카드매출", 25480000, 2640000, 356400, 2283600, 27763600],
    ["합계", 177442550, 19158372, 53490430, -34332058, 143110492],
  ]);
  // Income across accounts is merged in time order.
  expect(values(book.getWorksheet("수입")!).map((row) => row[3])).toEqual(["(주)대성상사", "BC카드", "미래테크(주)", "기업은행", "4건"]);
});

it("lists an account with no activity on the date at its previous balance", async () => {
  const quiet = await buildBankStatement(OPERATING_ROWS.filter(([at]) => !at.startsWith("2026.10.14")));
  const result = await run([{ name: "조용한계좌.xlsx", bytes: quiet }, (await statements())[0]]);
  if (result.status !== "completed") throw new Error(JSON.stringify(result));
  const book = new ExcelJS.Workbook(); await book.xlsx.load(Buffer.from(result.file.bytes) as unknown as ExcelJS.Buffer);
  expect(values(book.getWorksheet("요약")!)[0]).toEqual(["조용한계좌", 25480000, 0, 0, 0, 25480000]);
});

it("refuses a statement whose balances do not chain, naming the file", async () => {
  const broken = await buildBankStatement(BANK_ROWS.filter(([, memo]) => memo !== "원천세"));
  expect(await run([{ name: "기업은행.xlsx", bytes: broken }])).toMatchObject({ status: "failed", message: expect.stringMatching(/^기업은행 \d+행: 거래 후 잔액/) });
});

it("refuses the same account exported twice instead of double-counting", async () => {
  const [main] = await statements();
  expect(await run([main, { ...main, name: "기업은행_다시받음.xlsx" }])).toMatchObject({ status: "failed", message: expect.stringContaining("같은 거래") });
});

it("fails when the business date has no transactions in any file", async () => {
  expect(await run(await statements(), "2026-10-16")).toMatchObject({ status: "failed", message: expect.stringContaining("2026-10-16") });
});
