// Writes sample corporate bank exports (one file per account, newest-first, title rows above the header) for the bank_daily test tool.
// Usage: npx vite-node scripts/bank-fixture.ts fixtures/
import ExcelJS from "exceljs";

// [거래일시, 적요, 내용, 출금액, 입금액, 잔액] in chronological order; 2026-10-14 is the test business date.
export const BANK_ROWS: [string, string, string, number, number, number][] = [
  ["2026.10.13 09:05:11", "매출입금", "(주)한빛유통", 0, 8250000, 160590000],
  ["2026.10.13 11:20:43", "임대료", "강남빌딩관리", 5500000, 0, 155090000],
  ["2026.10.13 15:42:07", "카드대금", "신한카드", 3127450, 0, 151962550],
  ["2026.10.14 08:30:00", "급여", "10월 급여(일괄)", 42180000, 0, 109782550],
  ["2026.10.14 09:14:22", "매출입금", "(주)대성상사", 0, 12100000, 121882550],
  ["2026.10.14 10:02:51", "원천세", "관악세무서", 3846210, 0, 118036340],
  ["2026.10.14 11:47:09", "매출입금", "미래테크(주)", 0, 4400000, 122436340],
  ["2026.10.14 13:15:36", "외상매입", "(주)서진물산", 6820000, 0, 115616340],
  ["2026.10.14 14:03:18", "이체수수료", "기업은행", 500, 0, 115615840],
  ["2026.10.14 16:28:44", "예금이자", "기업은행", 0, 18372, 115634212],
  ["2026.10.14 17:55:02", "통신비", "KT", 287320, 0, 115346892],
  ["2026.10.15 09:10:15", "매출입금", "(주)한빛유통", 0, 5500000, 120846892],
  ["2026.10.15 10:40:00", "보험료", "국민건강보험공단", 2915600, 0, 117931292],
];

// Second account (operating card-sales account) at another bank.
export const OPERATING_ROWS: typeof BANK_ROWS = [
  ["2026.10.13 16:20:00", "카드매출입금", "KB국민카드", 0, 1980000, 25480000],
  ["2026.10.14 10:30:12", "카드매출입금", "BC카드", 0, 2640000, 28120000],
  ["2026.10.14 15:05:47", "소모품비", "(주)오피스디포", 356400, 0, 27763600],
  ["2026.10.15 09:00:00", "자금이체", "기업은행", 5000000, 0, 22763600],
];
export const STATEMENTS = [
  { file: "기업은행_법인주거래.xlsx", account: "123-456789-01-011 (테스트법인)", rows: BANK_ROWS },
  { file: "국민은행_카드매출.xlsx", account: "987-65-4321-00 (테스트법인)", rows: OPERATING_ROWS },
];

export async function buildBankStatement(rows = BANK_ROWS, account = STATEMENTS[0].account): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("거래내역조회");
  sheet.addRows([["거래내역조회"], ["조회계좌", account], ["조회기간", "2026.10.13 ~ 2026.10.15"]]);
  sheet.addRow(["거래일시", "적요", "내용", "출금액", "입금액", "잔액"]);
  sheet.addRows([...rows].reverse().map(([at, memo, party, out, income, balance]) => [at, memo, party, out || null, income || null, balance]));
  return Buffer.from(await book.xlsx.writeBuffer());
}

const outDir = process.argv[2];
// vitest also imports this module and has its own argv.
if (outDir && !process.env.VITEST) {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  await mkdir(outDir, { recursive: true });
  for (const { file, account, rows } of STATEMENTS) {
    await writeFile(join(outDir, file), await buildBankStatement(rows, account));
    console.log(`wrote ${join(outDir, file)}`);
  }
}
