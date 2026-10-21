import ExcelJS from "exceljs";
import { loadWorkbook } from "../work/mapping.ts";
import type { BusinessTool } from "./contracts.ts";

// Title rows (조회계좌·조회기간) sit above the header in bank exports.
const HEADER_SCAN_ROWS = 20;
const HEADERS = { at: "거래일시", memo: "적요", party: "내용", out: "출금액", in: "입금액", balance: "잔액" } as const;
const AMOUNT_FORMAT = "#,##0";
type Transaction = { row: number; at: string; memo: string; party: string; in: number; out: number; balance: number };

function dateTime(value: ExcelJS.CellValue, row: number): string {
  if (value instanceof Date) return value.toISOString().slice(0, 19).replace("T", " ");
  const match = String(value ?? "").trim().match(/^(\d{4})[-./](\d{2})[-./](\d{2})(?:\s+(\d{2}:\d{2}(?::\d{2})?))?$/);
  if (!match) throw new Error(`${row}행: 거래일시 형식을 읽을 수 없습니다.`);
  return `${match[1]}-${match[2]}-${match[3]} ${match[4] ?? "00:00:00"}`;
}

// ponytail: 원화 정수만 지원, 외화 계좌(소수점 금액)가 들어오면 decimal 처리로 확장
function amount(value: ExcelJS.CellValue, row: number, label: string): number {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "object") throw new Error(`${row}행 ${label}: 수식·링크 셀은 사용할 수 없습니다. 값으로 저장된 거래내역을 사용해 주세요.`);
  const text = String(value).trim();
  const number = typeof value === "number" ? value : /^-?\d{1,3}(,\d{3})*$|^-?\d+$/.test(text) ? Number(text.replaceAll(",", "")) : NaN;
  if (!Number.isSafeInteger(number) || (number < 0 && label !== HEADERS.balance)) throw new Error(`${row}행 ${label}: 원 단위 정수 금액이어야 합니다.`);
  return number;
}

export function readTransactions(sheet: ExcelJS.Worksheet): Transaction[] {
  let headerRow = 0;
  const columns: Partial<Record<keyof typeof HEADERS, number>> = {};
  for (let r = 1; r <= Math.min(HEADER_SCAN_ROWS, sheet.rowCount) && !headerRow; r++) {
    sheet.getRow(r).eachCell((cell, col) => {
      const key = (Object.keys(HEADERS) as (keyof typeof HEADERS)[]).find((name) => HEADERS[name] === cell.text.trim());
      if (key) columns[key] = col;
    });
    if (columns.at) headerRow = r;
  }
  const missing = (Object.keys(HEADERS) as (keyof typeof HEADERS)[]).filter((key) => !columns[key]).map((key) => HEADERS[key]);
  if (!headerRow || missing.length) throw new Error(`거래내역 헤더를 찾지 못했습니다: ${missing.join(", ")}`);
  const result: Transaction[] = [];
  for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    if (!row.hasValues) continue;
    const cell = (key: keyof typeof HEADERS) => row.getCell(columns[key]!);
    result.push({
      row: r, at: dateTime(cell("at").value, r), memo: cell("memo").text.trim(), party: cell("party").text.trim(),
      in: amount(cell("in").value, r, HEADERS.in), out: amount(cell("out").value, r, HEADERS.out), balance: amount(cell("balance").value, r, HEADERS.balance),
    });
  }
  return result;
}

type Account = { name: string; opening: number; closing: number; today: Transaction[] };
const fail = (message: string) => ({ status: "failed" as const, message });
const total = (rows: Transaction[], key: "in" | "out") => rows.reduce((sum, t) => sum + t[key], 0);

/** One file = one account statement, so balances chain within a file only. */
function account(name: string, all: Transaction[], date: string): Account | string {
  // Bank exports are often newest-first; flip so balances run forward, then a stable sort keeps same-second order.
  if (all.length > 1 && all[0].at > all.at(-1)!.at) all.reverse();
  all.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const today = all.filter((t) => t.at.startsWith(date));
  const previous = all.filter((t) => t.at.slice(0, 10) < date).at(-1);
  if (!today.length && !previous) return `${name}: ${date} 및 그 이전 거래가 없어 잔액을 알 수 없습니다. 조회기간을 확인해 주세요.`;
  const opening = previous?.balance ?? today[0].balance - today[0].in + today[0].out;
  const broken = today.find((t, i) => (i ? today[i - 1].balance : opening) + t.in - t.out !== t.balance);
  if (broken) return `${name} ${broken.row}행: 거래 후 잔액이 이전 잔액과 입출금액으로 계산한 값과 다릅니다. 누락된 거래가 있는지 확인해 주세요.`;
  const both = today.find((t) => (t.in > 0) === (t.out > 0));
  if (both) return `${name} ${both.row}행: 입금액과 출금액 중 하나만 있어야 합니다.`;
  return { name, opening, closing: today.at(-1)?.balance ?? opening, today };
}

async function writeReport(date: string, accounts: Account[]): Promise<Uint8Array> {
  const book = new ExcelJS.Workbook();
  const amount = (header: string) => ({ header, width: 18, style: { numFmt: AMOUNT_FORMAT } });
  const overview = book.addWorksheet("요약");
  overview.columns = [{ header: "계좌(파일)", width: 28 }, amount("전일잔액"), amount("수입"), amount("지출"), amount("순증감"), amount("당일잔액")];
  const line = (name: string, rows: Transaction[], opening: number, closing: number) => [name, opening, total(rows, "in"), total(rows, "out"), total(rows, "in") - total(rows, "out"), closing];
  overview.addRows(accounts.map((a) => line(a.name, a.today, a.opening, a.closing)));
  const sum = (key: "opening" | "closing") => accounts.reduce((acc, a) => acc + a[key], 0);
  overview.addRow(line("합계", accounts.flatMap((a) => a.today), sum("opening"), sum("closing"))).font = { bold: true };
  overview.addRow([]); overview.addRow(["기준일", date]);
  for (const [name, key] of [["수입", "in"], ["지출", "out"]] as const) {
    const sheet = book.addWorksheet(name);
    sheet.columns = [{ header: "계좌(파일)", width: 28 }, { header: "시각", width: 10 }, { header: "적요", width: 14 }, { header: "내용", width: 24 }, amount("금액"), amount("거래후잔액"), { header: "원천 행", width: 9 }];
    const rows = accounts.flatMap((a) => a.today.filter((t) => t[key] > 0).map((t) => ({ account: a.name, t })))
      .sort((a, b) => (a.t.at < b.t.at ? -1 : a.t.at > b.t.at ? 1 : 0));
    sheet.addRows(rows.map(({ account, t }) => [account, t.at.slice(11), t.memo, t.party, t[key], t.balance, t.row]));
    sheet.addRow(["합계", "", "", `${rows.length}건`, rows.reduce((acc, { t }) => acc + t[key], 0)]).font = { bold: true };
  }
  for (const sheet of book.worksheets) sheet.getRow(1).font = { bold: true };
  return new Uint8Array(await book.xlsx.writeBuffer());
}

export const bankDailyTool: BusinessTool = {
  id: "bank_daily", version: "0.2.0-test", title: "일일 입출금 정리 (테스트)",
  description: "은행 거래내역 엑셀(계좌별 여러 파일 가능)에서 기준일의 수입(입금)과 지출(출금)을 계좌별·전체로 나누어 합계와 잔액 대사를 담은 엑셀표로 정리하는 테스트용 업무.",
  examples: ["오늘 거래내역으로 수입 지출 정리해줘", "은행 거래내역에서 오늘 입출금 엑셀로 뽑아줘"],
  requiredInputs: ["기준일", "은행 거래내역 엑셀 (계좌별 파일)"],
  fields: [
    { key: "businessDate", label: "기준일", type: "date", required: true },
    { key: "transactions", label: "은행 거래내역", type: "file", required: true, multiple: true },
  ],
  async execute({ values, files }) {
    const date = values.businessDate;
    const accounts: Account[] = [];
    const seen = new Map<string, string>();
    for (const file of files.transactions) {
      const name = file.name.replace(/\.xlsx$/i, "");
      let rows: Transaction[];
      try { rows = readTransactions((await loadWorkbook(file.bytes)).worksheets[0]); }
      catch (error) { return fail(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
      // The same account exported twice would double-count; identical rows across files are treated as that.
      for (const t of rows) {
        const key = [t.at, t.memo, t.party, t.in, t.out, t.balance].join("|");
        const other = seen.get(key);
        if (other && other !== name) return fail(`${other}와 ${name}에 같은 거래(${t.at} ${t.memo})가 있습니다. 같은 계좌를 두 번 넣었는지 확인해 주세요.`);
        seen.set(key, name);
      }
      const result = account(name, rows, date);
      if (typeof result === "string") return fail(result);
      accounts.push(result);
    }
    const today = accounts.flatMap((a) => a.today);
    if (!today.length) return fail(`${date} 거래가 거래내역에 없습니다. 기준일과 조회기간을 확인해 주세요.`);
    const totalIn = total(today, "in");
    const totalOut = total(today, "out");
    const reconciles = accounts.every((a) => a.opening + total(a.today, "in") - total(a.today, "out") === a.closing);
    return {
      status: "completed",
      summary: `${date} 계좌 ${accounts.length}개 · 수입 ${today.filter((t) => t.in > 0).length}건 ${totalIn.toLocaleString("ko-KR")}원, 지출 ${today.filter((t) => t.out > 0).length}건 ${totalOut.toLocaleString("ko-KR")}원을 정리했습니다.`,
      file: { name: `일일입출금_${date}.xlsx`, bytes: await writeReport(date, accounts) },
      // Balance chaining, in/out exclusivity and cross-file duplicates already fail above with a row-level message.
      checks: [{ name: "계좌별 전일잔액 + 수입 - 지출 = 당일잔액", passed: reconciles }],
    };
  },
};
