import type ExcelJS from "exceljs";
import { compact, date, money, raw, text, type Amount } from "./values.ts";

export type Movement = { date: string; direction: "in" | "out"; description: string; party: string; amount: Amount; source: string; account?: string };
export function depositKind(m: Pick<Movement, "description" | "direction">) {
  const description = m.description.replace(/\s/g, "");
  if (m.direction === "in" && /정기예금만기/.test(description)) {
    if (/이자/.test(description)) return "interest";
    if (/원금/.test(description)) return "maturity";
  }
  if (m.direction === "out" && /정기예금(?:신규)?가입/.test(description)) return "subscription";
}
export function readWeekly(book: ExcelJS.Workbook, filename: string) {
  const sheet = book.getWorksheet("세부계획(원화,외화)");
  if (!sheet || compact(sheet.getCell("B3")) !== "일자" || compact(sheet.getCell("C4")) !== "구분" || compact(sheet.getCell("H4")) !== "구분" || compact(sheet.getCell("L4")) !== "금액") throw new Error(`${filename}: 확인된 주간계획 양식(세부계획(원화,외화))과 다릅니다.`);
  const result: Movement[] = []; const deposits: Movement[] = []; const dates = new Set<string>(); let current = ""; let ended = false;
  for (let r = 7; r <= sheet.rowCount; r++) {
    const marker = text(sheet.getCell(`B${r}`));
    if (marker === "지주-현금입금") { ended = true; break; }
    const v = raw(sheet.getCell(`B${r}`));
    if (v instanceof Date || (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v))) { current = date(v); dates.add(current); }
    for (const side of [{ category: "C", desc: "D", party: "F", amount: "G", direction: "in" }, { category: "H", desc: "I", party: "K", amount: "L", direction: "out" }] as const) {
      const category = compact(sheet.getCell(`${side.category}${r}`));
      if (!["지주현금", "사업예만", "사업예불", "사업현금"].includes(category)) continue;
      const description = text(sheet.getCell(`${side.desc}${r}`));
      if (/^(?:일계|합계|소계)$|사업부문현[금급](?:유입|유출)/.test(description.replace(/\s/g, ""))) continue;
      const kind = depositKind({ description, direction: side.direction });
      const deposit = (category === "사업예만" && kind === "maturity") || (category === "사업예불" && kind === "subscription") || (category === "사업현금" && kind === "interest");
      if (category !== "지주현금" && !deposit) continue;
      const party = text(sheet.getCell(`${side.party}${r}`));
      if (!current) throw new Error(`${filename}!${r}: 거래일을 확인할 수 없습니다.`);
      const amount = money(sheet.getCell(`${side.amount}${r}`));
      if (amount.lte(0)) throw new Error(`${filename}!${r}: 계획 금액은 양수여야 합니다.`);
      if (!description) throw new Error(`${filename}!${r}: 적요가 없습니다.`);
      (deposit ? deposits : result).push({ date: current, direction: side.direction, description, party, amount, source: `${filename}/${sheet.name}!${side.amount}${r}` });
    }
  }
  if (!ended || !dates.size) throw new Error(`${filename}: 주간계획의 날짜/상세행 종료 표식을 확인하세요.`);
  return { movements: result, deposits, dates };
}
