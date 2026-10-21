import type ExcelJS from "exceljs";
import { z } from "zod";
import { compact, date, decimal, money, raw, sum, text, type Amount } from "./values.ts";
import type { Movement } from "./weekly.ts";

export type KcAccount = { key: string; name: string; bank: string; currency: "KRW" | "USD" | "JPY" | "CNY"; product: string; opening: Amount; incoming: Amount; outgoing: Amount; ledger: Amount; balance: Amount; bookKrw: Amount; maturity?: string; start?: string; source: string };
export function readCashStatus(book: ExcelJS.Workbook) {
  const expected = ["계좌코드", "계좌명", "계좌번호", "환종", "기초(거래)잔액", "입금(거래)", "출금(거래)", "기말잔액(거래)", "계좌잔고", "기말잔액(장부)", "상품구분", "만기일", "가입일", "(금융)거래처"];
  const matches = book.worksheets.filter((s) => expected.every((h) => Array.from({ length: s.columnCount }, (_, c) => compact(s.getCell(1, c + 1))).includes(h)));
  if (matches.length !== 1) throw new Error("자금현황표(KC)의 계좌코드·환종·계좌잔고 헤더를 유일하게 찾을 수 없습니다. 양식 변경을 확인하세요.");
  const s = matches[0];
  const col = (h: string) => { const cols = Array.from({ length: s.columnCount }, (_, c) => c + 1).filter((c) => compact(s.getCell(1, c)) === h); if (cols.length !== 1) throw new Error(`중복 헤더: ${h}`); return cols[0]; };
  const c = Object.fromEntries(expected.map((h) => [h, col(h)]));
  const accounts: KcAccount[] = []; let total: Amount | undefined; let totalSource = ""; let ledgerTotal: Amount | undefined;
  for (let r = 2; r <= s.rowCount; r++) {
    const cell = (h: string) => s.getCell(r, c[h]);
    const currencyText = text(cell("환종")); if (!currencyText) continue;
    const currency = z.enum(["KRW", "USD", "JPY", "CNY"]).parse(currencyText);
    if (text(cell("계좌번호")) === "환종별합계") {
      if (currency === "KRW") { if (total) throw new Error("KRW 합계 중복"); total = money(cell("계좌잔고")); ledgerTotal = money(cell("기말잔액(거래)")); totalSource = `${s.name}!${cell("계좌잔고").address}`; }
      continue;
    }
    const code = text(cell("계좌코드")); if (!code) throw new Error(`${s.name}!${r}: 계좌코드 없음`);
    const key = `${code}:${currency}`;
    if (accounts.some((a) => a.key === key)) throw new Error(`중복 계좌/통화: ${key}`);
    const optionalDate = (h: string) => raw(cell(h)) == null ? undefined : date(raw(cell(h)));
    const account: KcAccount = { key, name: text(cell("계좌명")), bank: text(cell("(금융)거래처")), currency, product: text(cell("상품구분")), opening: money(cell("기초(거래)잔액")), incoming: money(cell("입금(거래)")), outgoing: money(cell("출금(거래)")), ledger: money(cell("기말잔액(거래)")), balance: money(cell("계좌잔고")), bookKrw: money(cell("기말잔액(장부)")), maturity: optionalDate("만기일"), start: optionalDate("가입일"), source: `${s.name}!${cell("계좌잔고").address}` };
    if (!account.opening.plus(account.incoming).minus(account.outgoing).eq(account.ledger)) throw new Error(`${key}: 기초+입금-출금과 기말 장부잔액 불일치`);
    if (account.incoming.lt(0) || account.outgoing.lt(0)) throw new Error(`${key}: 음수 입출금은 지원하지 않습니다. 정정 거래를 확인하세요.`);
    accounts.push(account);
  }
  if (!total || !ledgerTotal) throw new Error("환종별합계 KRW의 계좌잔고/장부잔액이 없습니다.");
  if (!sum(accounts.filter((a) => a.currency === "KRW").map((a) => a.balance)).eq(total)) throw new Error("자금현황표의 KRW 계좌 합과 환종별합계가 다릅니다.");
  return { accounts, total, ledgerTotal, totalSource };
}
export function differences(plan: Movement[], actual: Movement[]) {
  const key = (m: Movement) => JSON.stringify([m.direction, m.description.trim(), m.party.trim()]);
  return [...new Set([...plan, ...actual].map(key))].flatMap((k) => {
    const p = sum(plan.filter((m) => key(m) === k).map((m) => m.amount)); const a = sum(actual.filter((m) => key(m) === k).map((m) => m.amount));
    return p.eq(a) ? [] : [{ key: JSON.parse(k) as string[], planned: p.toString(), actual: a.toString(), delta: a.minus(p).toString() }];
  });
}
export function parseOverrides(value?: string): Record<string, Amount> {
  if (!value) return {};
  const input = z.record(z.string().regex(/^[HI]\d{1,3}$/), z.union([z.string(), z.number()])).parse(JSON.parse(value));
  return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, decimal(v, k)]));
}
