import Decimal from "decimal.js";
import type ExcelJS from "exceljs";

export const Money = Decimal.clone({ precision: 30 });
export type Amount = Decimal;
/** KC 계좌잔고는 원 단위 정수이고 일보는 이자 소수 원을 그대로 이월하므로, 1원 미만 차이는 같은 금액으로 본다. 그 이상은 허용오차 없음. */
export const sameWon = (a: Decimal, b: Decimal.Value) => a.minus(b).abs().lt(1);
export const sum = (values: Decimal.Value[]) => values.reduce<Decimal>((total, value) => total.plus(value), new Money(0));
export function decimal(value: unknown, label: string): Decimal {
  if ((typeof value !== "number" && typeof value !== "string") || !/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(String(value).trim())) throw new Error(`${label}: 숫자가 필요합니다. 빈 값은 0으로 추정하지 않습니다.`);
  const n = new Money(String(value).trim().replaceAll(",", ""));
  if (!n.isFinite() || n.abs().gt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label}: 금액 범위를 확인하세요.`);
  return n;
}
export function raw(cell: ExcelJS.Cell): unknown {
  const v = cell.value;
  if (v && typeof v === "object" && !(v instanceof Date)) {
    if ("formula" in v || "sharedFormula" in v) return cell.result;
    if ("richText" in v) return v.richText.map((x) => x.text).join("");
    if ("text" in v) return v.text;
    throw new Error(`${cell.address}: 오류 셀입니다.`);
  }
  return v;
}
export const text = (cell: ExcelJS.Cell) => String(raw(cell) ?? "").normalize("NFC").trim();
export const compact = (cell: ExcelJS.Cell) => text(cell).replace(/\s/g, "");
export const money = (cell: ExcelJS.Cell) => decimal(raw(cell), `${cell.worksheet.name}!${cell.address}`);
export function date(value: unknown): string {
  if (value instanceof Date) value = value.toISOString().slice(0, 10);
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("날짜는 YYYY-MM-DD 또는 Excel 날짜 셀이어야 합니다.");
  const d = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== value) throw new Error("유효하지 않은 날짜입니다.");
  return value;
}
export const shiftDate = (value: string, days: number) => new Date(new Date(`${date(value)}T00:00:00Z`).getTime() + days * 86400000).toISOString().slice(0, 10);
// 평일에 걸린 관공서 공휴일(대체공휴일·선거일·노동절 포함). 주말은 previousBusinessDay가 따로 건너뛴다.
// ponytail: 연도별 수동 표. 표에 없는 연도는 주말만 건너뛰므로 매년 말 다음 해를 추가한다(누락 시 KC 기준일 검증에서 멈춘다).
const HOLIDAYS = new Set([
  "2026-01-01", "2026-02-16", "2026-02-17", "2026-02-18", "2026-03-02", "2026-05-01", "2026-05-05", "2026-05-25", "2026-06-03", "2026-07-17", "2026-08-17", "2026-09-24", "2026-09-25", "2026-10-05", "2026-10-09", "2026-12-25",
  "2027-01-01", "2027-02-08", "2027-02-09", "2027-03-01", "2027-05-03", "2027-05-05", "2027-05-13", "2027-07-19", "2027-08-16", "2027-09-14", "2027-09-15", "2027-09-16", "2027-10-04", "2027-10-11", "2027-12-27",
]);
export function previousBusinessDay(value: string) {
  let day = shiftDate(value, -1);
  while ([0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay()) || HOLIDAYS.has(day)) day = shiftDate(day, -1);
  return day;
}
export const sheetDate = (value: string) => date(value).slice(2).replaceAll("-", "");
export const isoSheetDate = (value: string) => date(`20${value.slice(0, 2)}-${value.slice(2, 4)}-${value.slice(4, 6)}`);
export function numeric(cell: ExcelJS.Cell, value: Decimal.Value) { cell.value = decimal(value instanceof Money ? value.toString() : value, cell.address).toNumber(); }
