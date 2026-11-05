import { createHash } from "node:crypto";
import { z } from "zod";
import type { KcAccount } from "./cashStatus.ts";
import { date, decimal, nextBusinessDay, previousBusinessDay, shiftDate, sum } from "./values.ts";

export const CAPER_CASH_URL = "https://caper.kct.co.kr/api/agent-tools/erp_cash_status_kc";
const amount = z.union([z.string(), z.number()]);
const label = z.string().trim().min(1);
const rowSchema = z.object({
  FINPRODUCT_CD: label, FINPRODUCT_NM: label, PARTNER_NM: label, NM_TP_DEPOSIT: label,
  EXCH_CD: z.string().trim().nullable(), JOIN_DT: z.string().nullable(), END_DT: z.string().nullable(),
  AM_BASICS: amount, ACNT_IAMT_AMT: amount, AM_WITHDRAW: amount, AM_FINAL: amount,
  AM_BASICS2: amount, ACNT_IAMT_AMT2: amount, AM_WITHDRAW2: amount, AM_FINAL2: amount,
  BLNC_AMT: amount,
});
const responseSchema = z.object({ success: z.literal(true), data: z.object({ rows: z.array(rowSchema).min(1).max(2000), rowCount: z.number().int(), truncated: z.literal(false) }).refine((data) => data.rowCount === data.rows.length) });
const snapshotSchema = z.object({ from_dt: z.string(), to_dt: z.string(), fetchedAt: z.iso.datetime(), responseHash: z.string().regex(/^[a-f0-9]{64}$/), rows: z.array(rowSchema).min(1).max(2000) });
export type ErpCashSnapshot = z.infer<typeof snapshotSchema>;

export function erpPeriod(workDate: string) {
  const reportDate = previousBusinessDay(date(workDate));
  const end = shiftDate(nextBusinessDay(reportDate), -1);
  // shortcut: 공휴일 표는 2026~2027년만 있다. 다른 연도 조회 전에 values.ts의 공휴일 표와 이 범위를 갱신한다.
  if ([reportDate, end].some((day) => !["2026", "2027"].includes(day.slice(0, 4)))) throw new Error("ERP 조회 연도의 영업일 달력이 없습니다. 공휴일 표를 갱신하세요.");
  return { from_dt: reportDate.replaceAll("-", ""), to_dt: end.replaceAll("-", "") };
}

export function createErpSnapshot(response: unknown, workDate: string, fetchedAt = new Date().toISOString()): ErpCashSnapshot {
  const parsed = responseSchema.safeParse(response);
  if (!parsed.success) throw new Error("ERP 응답이 불완전합니다. 필수 컬럼·행 수·truncated(false)를 확인하세요. 잘린 결과는 일보에 사용하지 않습니다.");
  return { ...erpPeriod(workDate), fetchedAt, responseHash: createHash("sha256").update(JSON.stringify(parsed.data)).digest("hex"), rows: parsed.data.data.rows };
}

export function readErpCashStatus(value: unknown, workDate: string) {
  const parsed = snapshotSchema.safeParse(value);
  if (!parsed.success) throw new Error("저장된 ERP 조회 결과가 올바르지 않습니다. 새 작업으로 다시 조회하세요.");
  const snapshot = parsed.data;
  const period = erpPeriod(workDate);
  if (snapshot.from_dt !== period.from_dt || snapshot.to_dt !== period.to_dt) throw new Error("ERP 조회 기간과 일보 기준일이 다릅니다. 새 작업으로 다시 조회하세요.");
  const keys = new Set<string>();
  const optionalDate = (value: string | null) => !value?.trim() ? undefined : date(value.trim().replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3"));
  const accounts: KcAccount[] = snapshot.rows.map((row, index) => {
    const currency = z.enum(["KRW", "USD", "JPY", "CNY"]).safeParse(row.EXCH_CD || "KRW");
    if (!currency.success) throw new Error(`ERP ${index + 1}행: 지원하지 않는 통화입니다.`);
    const key = `${row.FINPRODUCT_CD}:${currency.data}`;
    if (keys.has(key)) throw new Error("ERP 계좌코드/통화가 중복됩니다. 중복 합산하지 않습니다.");
    keys.add(key);
    const fx = currency.data !== "KRW";
    const account: KcAccount = {
      key, name: row.FINPRODUCT_NM, bank: row.PARTNER_NM, product: row.NM_TP_DEPOSIT, currency: currency.data,
      opening: decimal(fx ? row.AM_BASICS2 : row.AM_BASICS, "ERP 기초잔액"),
      incoming: decimal(fx ? row.ACNT_IAMT_AMT2 : row.ACNT_IAMT_AMT, "ERP 입금"),
      outgoing: decimal(fx ? row.AM_WITHDRAW2 : row.AM_WITHDRAW, "ERP 출금"),
      ledger: decimal(fx ? row.AM_FINAL2 : row.AM_FINAL, "ERP 장부잔액"),
      balance: decimal(row.BLNC_AMT, "ERP 은행잔액"), bookKrw: decimal(row.AM_FINAL, "ERP 원화 장부잔액"),
      start: optionalDate(row.JOIN_DT), maturity: optionalDate(row.END_DT), source: `ERP ${period.from_dt}~${period.to_dt} ${key} BLNC_AMT`,
    };
    if (!account.opening.plus(account.incoming).minus(account.outgoing).eq(account.ledger)) throw new Error(`ERP ${index + 1}행: 기초+입금-출금과 기말 장부잔액이 다릅니다.`);
    if (account.incoming.lt(0) || account.outgoing.lt(0)) throw new Error(`ERP ${index + 1}행: 음수 입출금은 지원하지 않습니다. 정정 거래를 확인하세요.`);
    if (account.product === "정기예금" && (!account.start || !account.maturity)) throw new Error(`ERP ${index + 1}행: 정기예금 가입일/만기일이 없습니다.`);
    return account;
  });
  return { accounts, total: sum(accounts.filter((a) => a.currency === "KRW").map((a) => a.balance)), ledgerTotal: sum(accounts.filter((a) => a.currency === "KRW").map((a) => a.ledger)), totalSource: `ERP ${period.from_dt}~${period.to_dt} 원화 BLNC_AMT 합계` };
}

export async function fetchErpCashStatus(workDate: string, signal: AbortSignal): Promise<ErpCashSnapshot> {
  signal.throwIfAborted();
  const period = erpPeriod(workDate);
  if (period.to_dt >= new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }).replaceAll("-", "")) throw new Error("ERP 조회 기간이 아직 마감되지 않았습니다. 다음 영업일에 실행하세요.");
  const token = process.env.CAPER_API_KEY?.trim();
  if (!token) throw new Error("ERP 조회 키가 없습니다. 로컬 .env.caper.local의 CAPER_API_KEY를 설정하고 앱을 다시 시작하세요.");
  let response: Response;
  try {
    response = await fetch(CAPER_CASH_URL, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(period), redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) });
  } catch {
    signal.throwIfAborted();
    throw new Error("ERP 서버에 연결하지 못했습니다. 네트워크를 확인하고 다시 실행하세요.");
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(response.status === 401 || response.status === 403 ? "ERP 인증/권한이 거부되었습니다. 키의 만료일과 조회 권한을 확인하세요." : `ERP 조회 실패 (HTTP ${response.status}).`);
  }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 1024 * 1024) throw new Error("ERP 응답 크기 초과"); chunks.push(value); }
  } catch {
    signal.throwIfAborted();
    throw new Error("ERP 응답을 끝까지 읽지 못했거나 1MB를 초과했습니다. 불완전한 결과는 사용하지 않습니다.");
  } finally { await reader.cancel().catch(() => undefined); }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("ERP 응답이 올바른 JSON이 아닙니다."); }
  const snapshot = createErpSnapshot(value, workDate);
  readErpCashStatus(snapshot, workDate);
  return snapshot;
}
