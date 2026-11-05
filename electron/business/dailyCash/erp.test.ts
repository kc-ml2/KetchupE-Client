// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { CAPER_CASH_URL, createErpSnapshot, erpPeriod, fetchErpCashStatus, readErpCashStatus } from "./erp.ts";

const row = (extra = {}) => ({ FINPRODUCT_CD: "001234", FINPRODUCT_NM: "테스트 계좌", PARTNER_NM: "테스트은행", NM_TP_DEPOSIT: "보통예금", EXCH_CD: "", JOIN_DT: "20260101", END_DT: null, AM_BASICS: "100", ACNT_IAMT_AMT: "20", AM_WITHDRAW: "5", AM_FINAL: "115", AM_BASICS2: "1", ACNT_IAMT_AMT2: "0.2", AM_WITHDRAW2: "0.05", AM_FINAL2: "1.15", BLNC_AMT: "114", ...extra });
const response = (rows = [row()]) => ({ success: true, data: { rows, rowCount: rows.length, truncated: false } });
const read = (value: unknown) => readErpCashStatus(createErpSnapshot(value, "2026-10-15"), "2026-10-15");
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

it("queries the prior business day through the day before its next business day", () => {
  expect(erpPeriod("2026-10-15")).toEqual({ from_dt: "20261014", to_dt: "20261014" });
  expect(erpPeriod("2026-11-02")).toEqual({ from_dt: "20261030", to_dt: "20261101" });
  expect(erpPeriod("2026-10-12")).toEqual({ from_dt: "20261008", to_dt: "20261011" });
  expect(() => erpPeriod("2028-01-04")).toThrow("달력");
});

it("uses bank balances, preserves leading zeros and foreign units, and excludes foreign balances from the KRW sum", () => {
  const result = read(response([row(), row({ FINPRODUCT_CD: "FX", EXCH_CD: "USD", BLNC_AMT: "1.14" })]));
  expect(result.accounts.map(a => [a.key, a.opening.toString(), a.incoming.toString(), a.outgoing.toString(), a.ledger.toString(), a.balance.toString(), a.bookKrw.toString()])).toEqual([
    ["001234:KRW", "100", "20", "5", "115", "114", "115"], ["FX:USD", "1", "0.2", "0.05", "1.15", "1.14", "115"],
  ]);
  expect(result.total.toString()).toBe("114");
  expect(result.accounts[0].start).toBe("2026-01-01");
  expect(createErpSnapshot(response([row({ FINPRODUCT_NO: "private-number", token: "private-token" })]), "2026-10-15").rows[0]).not.toHaveProperty("FINPRODUCT_NO");
});

it("rejects failed, truncated, empty, missing, invalid, duplicated and inconsistent data without treating missing amounts as zero", () => {
  for (const value of [
    { success: false, data: response().data }, { success: true, data: { ...response().data, truncated: true } },
    { success: true, data: { ...response().data, rowCount: 2 } }, { success: true, data: { rows: [], rowCount: 0, truncated: false } },
    response([row({ BLNC_AMT: null })]), response([row({ AM_FINAL: "" })]), response([row({ AM_FINAL: "116" })]),
    response([row({ ACNT_IAMT_AMT: -1, AM_FINAL: 94 })]), response([row(), row()]), response([row({ EXCH_CD: "EUR" })]),
    response([row({ JOIN_DT: "20260230" })]), response([row({ NM_TP_DEPOSIT: "정기예금" })]), response([row({ BLNC_AMT: Number.MAX_SAFE_INTEGER + 1 })]),
  ]) expect(() => read(value)).toThrow();
  const saved = createErpSnapshot(response(), "2026-10-15");
  expect(() => readErpCashStatus(saved, "2026-10-16")).toThrow("조회 기간");
});

it("sends only the date range to the fixed read-only endpoint and keeps the key out of the snapshot", async () => {
  vi.stubEnv("CAPER_API_KEY", "private-test-key");
  const request = vi.fn(async () => Response.json(response())); vi.stubGlobal("fetch", request);
  const snapshot = await fetchErpCashStatus("2026-10-15", new AbortController().signal);
  expect(request).toHaveBeenCalledExactlyOnceWith(CAPER_CASH_URL, expect.objectContaining({ method: "POST", headers: { Authorization: "Bearer private-test-key", "Content-Type": "application/json" }, redirect: "error", body: '{"from_dt":"20261014","to_dt":"20261014"}' }));
  expect(JSON.stringify(snapshot)).not.toContain("private-test-key");
});

it("does not request ERP without a key or for a period that has not closed", async () => {
  vi.stubEnv("CAPER_API_KEY", ""); const request = vi.fn(); vi.stubGlobal("fetch", request);
  await expect(fetchErpCashStatus("2026-10-15", new AbortController().signal)).rejects.toThrow("키가 없습니다");
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-31T03:00:00Z"));
  await expect(fetchErpCashStatus("2026-10-31", new AbortController().signal)).rejects.toThrow("마감되지");
  expect(request).not.toHaveBeenCalled();
});

it("handles authorization, malformed bodies, oversized bodies and cancellation without exposing remote text", async () => {
  vi.stubEnv("CAPER_API_KEY", "private-test-key");
  const request = vi.fn(); vi.stubGlobal("fetch", request);
  request.mockResolvedValueOnce(new Response("private-key-echo", { status: 401 }));
  await expect(fetchErpCashStatus("2026-10-15", new AbortController().signal)).rejects.toThrow("인증/권한");
  request.mockResolvedValueOnce(new Response("private-key-echo"));
  await expect(fetchErpCashStatus("2026-10-15", new AbortController().signal)).rejects.toThrow("JSON");
  request.mockResolvedValueOnce(new Response("x".repeat(1024 * 1024 + 1)));
  await expect(fetchErpCashStatus("2026-10-15", new AbortController().signal)).rejects.toThrow("1MB");
  request.mockRejectedValueOnce(new Error("private-key-echo"));
  const abort = new AbortController(); abort.abort(new Error("cancelled"));
  await expect(fetchErpCashStatus("2026-10-15", abort.signal)).rejects.toThrow("cancelled");
});
