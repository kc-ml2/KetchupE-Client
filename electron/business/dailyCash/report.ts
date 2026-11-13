import ExcelJS from "exceljs";
import { compact, isoSheetDate, Money, money, numeric, raw, sameWon, sheetDate, sum, text, type Amount } from "./values.ts";
import type { KcAccount } from "./cashStatus.ts";
import { depositKind, type Movement } from "./weekly.ts";
import type { Rates } from "./hana.ts";
import type { SelectiveWorkbook } from "../../work/selectiveWorkbook.ts";

export const cashRows = [9, 10, 11, 12, 13, 15, 21, 23, 24, 26, 28, 30];
export const cashAccountOptions = (s: ExcelJS.Worksheet) => cashRows.filter((r) => r < 20).map((r) => ({ value: `H${r}`, label: text(s.getCell(`C${r}`)) || `현금 ${r}` }));
const transferEndpoints = (description: string) => {
  const match = description.normalize("NFKC").replace(/\s/g, "").match(/^(.*?)에서(.+?)자금대체/);
  return match ? { in: match[2], out: match[1] } : undefined;
};
function linkedCashAccount(s: ExcelJS.Worksheet, description: string) {
  const labels = [...description.normalize("NFKC").replace(/\s/g, "").matchAll(/(?:^|\()([^()]+?)연동계좌(?:\)|$)/g)].map((match) => match[1]);
  if (!labels.length) return;
  const matches = cashAccountOptions(s).filter((a) => labels.every((label) => a.label.normalize("NFKC").replace(/\s/g, "") === label));
  return { label: labels.join(" / "), target: matches.length === 1 ? matches[0].value : undefined };
}
/** 받을어음·적금 rows sit above the term-deposit sections and have been identical in every workbook seen (5월·10월). */
const noteRows = [35, 36, 37, 38, 39, 40, 41, 46];
const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
export type Layout = ReturnType<typeof layout>;
/** Rows from 정기예금 downwards move whenever a deposit row is inserted or deleted, so every section below row 49 is located by its labels and 합계 formula. */
export function layout(s: ExcelJS.Worksheet) {
  const anchors = { A7: "단기성현금자산(원화)", A19: "단기성현금자산(외화)", A49: "정기예금현황(원화)" };
  for (const [cell, label] of Object.entries(anchors)) if (compact(s.getCell(cell)) !== label) throw new Error(`일보 양식 ${cell} (${label})이 변경되었습니다.`);
  const last = Math.min(s.rowCount, 600);
  const find = (column: string, predicate: (v: string) => boolean) => {
    const rows = range(1, last).filter((r) => predicate(compact(s.getCell(`${column}${r}`))));
    if (rows.length !== 1) throw new Error(`일보 ${column}열 표식을 유일하게 찾을 수 없습니다.`); return rows[0];
  };
  const first = (label: string, from: number, predicate: (r: number) => boolean) => {
    const row = range(from, last).find(predicate);
    if (!row) throw new Error(`일보 ${from}행 아래에서 ${label}을 찾을 수 없습니다.`); return row;
  };
  const sumRowAfter = (label: string, from: number) => first(`${label} 합계`, from, (r) => String(s.getCell(`D${r}`).formula ?? "").startsWith("SUM("));
  const header = (label: string, from: number) => first(label, from, (r) => compact(s.getCell(`A${r}`)) === label);
  const krwTermSum = sumRowAfter("정기예금(원화)", 51);
  const fxHeader = header("정기예금현황(외화)", krwTermSum); const fxTermSum = sumRowAfter("정기예금(외화)", fxHeader + 2);
  const trustHeader = header("신탁현황", fxTermSum); const trustSum = sumRowAfter("신탁", trustHeader + 2);
  const opening = first("기초금액", trustSum, (r) => compact(s.getCell(`A${r}`)).startsWith("기초금액("));
  const inSum = sumRowAfter("입금", opening + 1);
  const closing = first("마감잔액", inSum, (r) => compact(s.getCell(`A${r}`)).startsWith("마감잔액("));
  const outSum = closing - 1;
  const total = find("G", (v) => v === "총원화") + 1;
  const business = find("O", (v) => v === "사업부문자금현황표(KC)");
  if (closing > 500 || total !== closing + 11 || business !== closing + 1 || !String(s.getCell(`D${outSum}`).formula ?? "").startsWith("SUM(")) throw new Error("일보 집행내역/합계 배치가 확인된 양식과 다릅니다.");
  const businessRows = range(business + 1, business + 11);
  const krwTermRows = range(51, krwTermSum - 1); const fxTermRows = range(fxHeader + 2, fxTermSum - 1); const trustRows = range(trustHeader + 2, trustSum - 1);
  const termRows = [...krwTermRows, ...fxTermRows];
  const activeTerms = termRows.filter((r) => text(s.getCell(`C${r}`)));
  return { closing, total, businessRows, krwTermRows, fxTermRows, termRows, krwTermSum, fxTermSum, fxHeader, trustRows, trustSum, otherRows: [...noteRows, ...trustRows], activeTerms, opening, inSum, outSum };
}
// ponytail: every 외화 정기예금 row is treated as USD (K열이 $K$21). A JPY/CNY deposit fails the currency check in bindAccounts instead of being mis-rated.
export const currencyAt = (row: number, l: Layout) => [23, 24].includes(row) ? "JPY" : row === 26 ? "CNY" : [21, 28, 30].includes(row) || l.fxTermRows.includes(row) ? "USD" : "KRW";
export function priorAmounts(s: ExcelJS.Worksheet, overrides: Record<string, Amount>) {
  const l = layout(s); const values: Record<string, Amount> = {}; const missing: string[] = [];
  for (const row of [...cashRows, ...l.termRows, ...l.otherRows]) {
    for (const col of currencyAt(row, l) === "KRW" ? ["H"] : ["H", "I"]) {
      const key = `${col}${row}`;
      // 수식 없이 완전히 빈 셀은 Excel 산술과 같이 0이다. 수식인데 저장된 결과가 없는 셀만 담당자에게 묻는다.
      const cell = s.getCell(key); const blank = cell.value === null || cell.value === undefined || cell.value === "";
      try { values[key] = (overrides[key] ?? (blank || text(cell) === "-" ? new Money(0) : money(cell))).round(); }
      catch { missing.push(key); }
    }
  }
  return { values, missing };
}
/** 전일 예정표도 실적 확인의 초안으로 사용하며 동일 거래는 출처별로 한 번씩만 대응한다. */
export function withPriorPlan(weekly: Movement[], previous: ExcelJS.Worksheet, reportDate: string): Movement[] {
  const l = layout(previous);
  const plannedDay = compact(previous.getCell(`E${l.opening}`)).match(/^기초금액\((\d{1,2})\/(\d{1,2})\)$/);
  if (!plannedDay || Number(plannedDay[1]) !== Number(reportDate.slice(5, 7)) || Number(plannedDay[2]) !== Number(reportDate.slice(8))) return weekly;
  const result = weekly.map((m) => ({ ...m })); const matched = new Set<number>();
  const key = (m: Movement) => `${m.direction}:${`${m.description}${m.party ? ` / ${m.party}` : ""}`.replace(/\s/g, "")}:${m.amount}`;
  for (const direction of ["in", "out"] as const) {
    const first = direction === "in" ? l.opening + 1 : l.inSum + 1;
    const last = direction === "in" ? l.inSum - 1 : l.outSum - 1;
    for (let row = first; row <= last; row++) {
      const cell = previous.getCell(`H${row}`), value = raw(cell);
      if (value == null || value === "" || value === "-") { if (cell.formula) throw new Error(`${previous.name}!${cell.address}: 예정금액 수식을 Excel에서 계산하고 저장하세요.`); continue; }
      const amount = money(cell).round(); if (amount.isZero()) continue;
      if (amount.lt(0)) throw new Error(`${previous.name}!${cell.address}: 예정금액은 0 이상이어야 합니다.`);
      const description = text(previous.getCell(`F${row}`));
      const party = previous.getCell(`G${row}`).isMerged ? "" : text(previous.getCell(`G${row}`));
      if (!description) throw new Error(`${previous.name}!F${row}: 예정내역의 적요가 없습니다.`);
      const entry: Movement = { date: reportDate, direction, description, party, amount, source: `전일 금일집행내역(예정) / ${previous.name}!H${row}` };
      const duplicate = weekly.findIndex((m, i) => !matched.has(i) && key(m) === key(entry));
      if (duplicate >= 0) { matched.add(duplicate); result[duplicate].source += `; ${entry.source}`; }
      else result.push(entry);
    }
  }
  return result;
}
const bankGroup = (v: string) => ["기업", "하나", "신한", "우리", "NH"].find((b) => v.includes(b) || (b === "NH" && v.includes("엔에이치")));
export function maturity(s: ExcelJS.Worksheet, row: number) {
  const m = text(s.getCell(`A${row}`)).match(/~\s*(\d{6})(?!\d)/);
  if (!m) throw new Error(`정기예금 ${row}행에 YYMMDD 만기일이 없습니다.`);
  return isoSheetDate(m[1]);
}
export function bindAccounts(s: ExcelJS.Worksheet, accounts: KcAccount[], previous: Record<string, Amount>, explicit: Record<string, string>, reportDate: string, movements: Movement[] = []) {
  const l = layout(s); const bindings = new Map<string, string>(); const used = new Set<string>(); const unresolved: string[] = [];
  const businessTargets: Record<string, string> = { "33889000081904:KRW": "보통예금하나", "33889007370038:USD": "하나USD", "33889000330952:KRW": "MMT하나", "140002733206:KRW": "보통예금신한1", "140005948841:KRW": "보통예금신한2", "180007074373:CNY": "신한CNY", "180007074373:USD": "신한USD" };
  const allowed = new Set([...cashRows, ...l.termRows].map((r) => `H${r}`).concat(l.businessRows.map((r) => `P${r}`)));
  for (const a of accounts) {
    const newTerm = a.product === "정기예금" && Boolean(a.bank.trim()) && a.start === reportDate && a.opening.isZero() && a.incoming.gt(0) && a.outgoing.isZero() && a.balance.eq(a.incoming) && a.maturity && a.maturity > reportDate;
    let target: string | undefined = explicit[a.key];
    if (!target && a.key === "140013557434:KRW") target = "H10";
    if (!target && a.key === "140013557473:KRW") target = "H11";
    if (!target && businessTargets[a.key]) { const row = l.businessRows.find((r) => compact(s.getCell(`O${r}`)) === businessTargets[a.key]); if (row) target = `P${row}`; }
    if (!target && a.currency === "KRW" && a.product !== "정기예금") {
      const code = a.key.split(":")[0].replace(/-/g, "");
      const endpoints = movements.flatMap((m) => Object.values(transferEndpoints(m.description) ?? {})).filter((value) => (value.replace(/-/g, "").match(/\d+/g) ?? []).some((number) => number === code));
      const links = [a.name, ...endpoints].flatMap((value) => { const link = linkedCashAccount(s, value); return link ? [link] : []; });
      if (links.length) {
        const targets = new Set(links.map((link) => link.target));
        if (targets.size !== 1 || targets.has(undefined)) { unresolved.push(`${a.key}: 연동계좌 설명(${links.map((link) => link.label).join(", ")})을 일보 거래처에 유일하게 연결할 수 없습니다. 연결 위치를 확인하세요.`); continue; }
        target = links[0].target;
      }
    }
    if (!target && a.product === "정기예금") {
      const candidates = l.activeTerms.filter((r) => !used.has(`H${r}`) && currencyAt(r, l) === a.currency && bankGroup(a.bank) !== undefined && bankGroup(text(s.getCell(`C${r}`))) === bankGroup(a.bank) && maturity(s, r) === a.maturity && previous[`H${r}`]?.eq(a.opening));
      // Equal bank/currency/maturity/principal slots are interchangeable; the review records each assignment.
      if (candidates.length && !newTerm) target = `H${candidates[0]}`;
      if (!target && newTerm) {
        // shortcut: 신규 예금은 기존 빈 행을 사용한다. 빈 행이 소진되면 양식의 예금 구역을 확장해야 한다.
        const row = l.termRows.find((r) => !used.has(`H${r}`) && currencyAt(r, l) === a.currency && !text(s.getCell(`A${r}`)) && !text(s.getCell(`C${r}`)) && previous[`H${r}`]?.isZero());
        if (row) target = `H${row}`;
      }
    }
    if (!target) {
      // 은행·통화·원금은 같은데 만기만 다른 행이 있으면 대개 한쪽 자료의 만기 표기 오류다. 어느 셀을 봐야 하는지 알려준다.
      const near = a.product === "정기예금" ? l.activeTerms.filter((r) => !used.has(`H${r}`) && currencyAt(r, l) === a.currency && bankGroup(text(s.getCell(`C${r}`))) === bankGroup(a.bank) && previous[`H${r}`]?.eq(a.opening) && maturity(s, r) !== a.maturity) : [];
      const because = near.length ? ` → 일보 ${near.map((r) => `H${r}(만기 ${maturity(s, r)}, A${r} "${text(s.getCell(`A${r}`))}")`).join(", ")}와 은행·원금이 같지만 만기가 다릅니다. 전일 일보의 만기 표기 또는 KC 만기일을 확인해 고친 뒤 새 작업을 시작하세요.` : "";
      unresolved.push(`${a.key} / ${a.name} / ${a.currency} / 잔고 ${a.balance} / 만기 ${a.maturity ?? "없음"}${newTerm ? " / 신규 가입에 사용할 같은 통화의 빈 예금 행이 없습니다. 양식을 확장하세요." : ""}${because}`); continue;
    }
    if (!allowed.has(target) || used.has(target)) throw new Error(`${a.key}: 일보 셀 ${target}이 허용되지 않거나 중복됩니다.`);
    const row = Number(target.slice(1));
    const expected = target[0] === "H" ? currencyAt(row, l) : /USD/.test(text(s.getCell(`O${row}`))) ? "USD" : /JPY/.test(text(s.getCell(`O${row}`))) ? "JPY" : /CNY/.test(text(s.getCell(`O${row}`))) ? "CNY" : "KRW";
    if (a.currency !== expected || (a.product === "정기예금") !== (target[0] === "H" && l.termRows.includes(row))) throw new Error(`${a.key}: 통화/정기예금 구분과 대상 셀이 다릅니다.`);
    if (l.termRows.includes(row) && target[0] === "H") {
      if (l.activeTerms.includes(row) ? newTerm || maturity(s, row) !== a.maturity : !newTerm || text(s.getCell(`A${row}`)) || !previous[target]?.isZero()) throw new Error(`${a.key}: 전일 일보의 만기일/예금 항목과 다릅니다. 신규 예금은 가입일·만기일·기초 0원과 빈 행을 확인하세요.`);
    }
    bindings.set(a.key, target); used.add(target);
  }
  for (const r of [...cashRows, ...l.activeTerms]) if (!used.has(`H${r}`) && previous[`H${r}`] && !previous[`H${r}`].isZero() && !(l.termRows.includes(r) && maturity(s, r) <= reportDate)) unresolved.push(`일보 H${r} (${text(s.getCell(`C${r}`))}, ${previous[`H${r}`]})에 대응하는 KC 계좌가 없습니다.`);
  return { bindings, unresolved };
}
/** 거래가 놓인 행과 계좌는 별개다. 적요의 계좌 또는 KC 증감으로 유일하게 연결되는 거래만 자동 배정한다. */
export function assignCashMovements(s: ExcelJS.Worksheet, accounts: KcAccount[], bindings: Map<string, string>, items: Movement[], changes: Record<string, { incoming: Amount; outgoing: Amount }>) {
  const options = cashAccountOptions(s), allowed = new Set(options.map((a) => a.value));
  const remaining = new Map(options.map((a) => [a.value, { in: new Money(0), out: new Money(0) }]));
  for (const a of accounts) {
    const target = bindings.get(a.key); if (!target || !allowed.has(target)) continue;
    const flow = changes[a.key] ?? a;
    remaining.set(target, { in: flow.incoming.round(), out: flow.outgoing.round() });
  }
  const issues: string[] = [], ambiguous = new Set<Movement>();
  const movements = items.map((m) => ({ ...m, amount: m.amount.round() })).filter((m) => m.amount.gt(0));
  for (const m of movements) {
    if (!m.account) {
      const description = m.description.replace(/\s/g, "");
      const transfer = transferEndpoints(description), endpoint = transfer?.[m.direction] ?? description;
      const link = transfer ? linkedCashAccount(s, endpoint) : undefined;
      if (link) {
        m.account = link.target;
        if (!m.account) { ambiguous.add(m); issues.push(`${m.description}: '${link.label}' 연동계좌에 해당하는 원화 거래처를 유일하게 찾을 수 없습니다. 거래 계좌를 선택하세요.`); }
      } else {
        const matches = options.filter((a) => {
          const identifiers = [...a.label.matchAll(/\d{6,}/g)].map((match) => match[0]);
          for (const [key, target] of bindings) if (target === a.value) identifiers.push(key.split(":")[0]);
          return identifiers.some((id) => /^\d{6,}$/.test(id) && (endpoint.replace(/-/g, "").match(/\d+/g) ?? []).some((number) => number.endsWith(id)));
        });
        if (matches.length === 1) m.account = matches[0].value;
      }
    }
    if (!m.account) continue;
    if (!allowed.has(m.account)) { issues.push(`${m.description}: 연결할 원화 계좌를 다시 선택하세요.`); continue; }
    const flow = remaining.get(m.account)!; flow[m.direction] = flow[m.direction].minus(m.amount);
  }
  let progress = true;
  while (progress) {
    progress = false;
    for (const m of movements.filter((m) => !m.account && !ambiguous.has(m))) {
      const candidates = [...remaining].filter(([, flow]) => flow[m.direction].gte(m.amount));
      if (candidates.length !== 1) continue;
      const [target, flow] = candidates[0]; m.account = target; flow[m.direction] = flow[m.direction].minus(m.amount); progress = true;
    }
  }
  for (const m of movements.filter((m) => !m.account)) issues.push(`${m.direction === "in" ? "입금" : "지급"} ${m.amount}원 / ${m.description}: 거래 계좌를 선택하세요.`);
  for (const [target, flow] of remaining) for (const direction of ["in", "out"] as const) {
    if (!flow[direction].isZero()) issues.push(`${options.find((a) => a.value === target)!.label}: 확인된 ${direction === "in" ? "입금" : "출금"}과 배정한 집행내역의 차이 ${flow[direction]}원`);
  }
  return { movements, issues };
}
/** 사업 분류의 예금 원금은 지주 입출금계좌 집행표와 분리해 KC 및 전일 예금과 대사한다. */
export function depositIssues(s: ExcelJS.Worksheet, previous: Record<string, Amount>, accounts: KcAccount[], bindings: Map<string, string>, actual: Movement[], reportDate: string) {
  const l = layout(s);
  const expected = l.krwTermRows.filter((r) => l.activeTerms.includes(r) && maturity(s, r) <= reportDate && previous[`H${r}`].gt(0)).map((r) => ({ kind: "maturity", bank: text(s.getCell(`C${r}`)), maturity: maturity(s, r), amount: previous[`H${r}`] }));
  for (const a of accounts) if (a.currency === "KRW" && a.product === "정기예금" && bindings.has(a.key) && a.incoming.gt(0)) expected.push({ kind: "subscription", bank: a.bank, maturity: a.maturity!, amount: a.incoming });
  const issues: string[] = [];
  // 거래처가 없는 일괄 가입 계획은 은행이 명시된 내역을 먼저 배분한 뒤 남은 원금과 대사한다.
  for (const m of [...actual].sort((a, b) => Number(Boolean(b.party)) - Number(Boolean(a.party)))) {
    const kind = depositKind(m); if (!kind || kind === "interest") continue;
    const due = m.description.match(/~\s*(\d{6})(?!\d)/)?.[1];
    let remaining = m.amount;
    for (const e of expected) {
      const sameBank = !m.party || m.party.replace(/\s/g, "") === e.bank.replace(/\s/g, "") || (bankGroup(m.party) !== undefined && bankGroup(m.party) === bankGroup(e.bank) && !(/지점|센터/.test(m.party) && /지점|센터/.test(e.bank)));
      if (e.kind !== kind || !sameBank || (kind === "maturity" && due && isoSheetDate(due) !== e.maturity)) continue;
      const used = Money.min(remaining, e.amount); remaining = remaining.minus(used); e.amount = e.amount.minus(used);
    }
    if (!remaining.isZero()) issues.push(`${m.description} / ${m.party}: 예금 현황과 맞지 않는 원금 ${remaining}원 (${m.source})`);
  }
  for (const e of expected) if (!e.amount.isZero()) issues.push(`${e.bank}: ${e.kind === "maturity" ? "만기 감소" : "가입 증가"} ${e.amount}원의 실제 집행 내역을 확인하세요.`);
  return issues;
}
/** True when D{row} was ='YYMMDD'!H{row} and the prior sheet's H{row} cache is exactly the carried amount (no manual override). */
function carriesPrior(previous: ExcelJS.Worksheet, row: number, amount: Amount) {
  const expression = previous.getCell(`D${row}`).formula?.replace(/^(?:TRUNC|ROUND)\((.*),0\)$/i, "$1");
  if (expression?.match(/^(?:'\d{6}'|\d{6})!\$?H\$?(\d+)$/i)?.[1] !== String(row)) return false;
  try { return money(previous.getCell(`H${row}`)).round().eq(amount); } catch { return false; }
}
function formula(s: ExcelJS.Worksheet, cell: string, expression: string, value: Amount) { s.getCell(cell).value = { formula: expression, result: value.toNumber() }; }
const integerFormula = (expression: string) => `ROUND(${expression.replace(/^(?:TRUNC|ROUND)\((.*),0\)$/i, "$1")},0)`;
/** Resolve dated references against their actual source layout; never infer an external workbook's meaning. */
export async function rolloverFormulas(archive: SelectiveWorkbook, previous: ExcelJS.Worksheet) {
  const l = layout(previous), formulas = new Map<string, string>(), sources = new Map<string, Layout>();
  const candidates: ExcelJS.Cell[] = [];
  previous.eachRow((row) => row.eachCell((cell) => { if (cell.type === ExcelJS.ValueType.Formula) candidates.push(cell); }));
  for (const cell of candidates) {
    const operands = cell.formula.split("=").map((part) => part.trim());
    if (operands.length !== 2) continue;
    const opening = operands.findIndex((part) => part.replaceAll("$", "").toUpperCase() === `D${l.opening}`);
    if (opening < 0) continue;
    const reference = operands[1 - opening].replace(/^(?:TRUNC|ROUND)\((.*),0\)$/i, "$1");
    if (/\[[^\]]+\]/.test(reference)) throw new Error(`${cell.address}: 외부 통합문서의 이월 참조는 추측해서 변경할 수 없습니다. 정상 원본에서 참조를 확인하고 내부 시트로 연결하세요.`);
    const target = reference.match(/^(?:'(\d{6})'|(\d{6}))!\$?([A-Z]+)\$?(\d+)$/i);
    if (!target) continue;
    const name = target[1] ?? target[2];
    if (!archive.sheetNames.includes(name) || name >= previous.name) throw new Error(`${cell.address}: 이월 검증의 과거 날짜 시트 ${name}를 확인할 수 없습니다.`);
    if (!sources.has(name)) sources.set(name, layout((await archive.loadSheet(name)).getWorksheet(name)!));
    const source = sources.get(name)!;
    const address = `${target[3].toUpperCase()}${target[4]}`;
    if (address !== `H${source.opening}` && address !== `D${source.closing}`) throw new Error(`${cell.address}: ${name}!${address}가 기초·마감금액 참조인지 확인할 수 없습니다.`);
    operands[1 - opening] = `ROUND('${previous.name}'!D${l.closing},0)`;
    formulas.set(cell.address, operands.join("="));
  }
  return formulas;
}
export function buildReport(book: ExcelJS.Workbook, previous: ExcelJS.Worksheet, reportDate: string, workDate: string, amounts: Record<string, Amount>, accounts: KcAccount[], bindings: Map<string, string>, actual: Movement[], plan: Movement[], rates: Rates, changes: Record<string, { incoming: Amount; outgoing: Amount }>, rollovers: Map<string, string>) {
  const assigned = assignCashMovements(previous, accounts, bindings, actual, changes);
  if (assigned.issues.length) throw new Error(`거래별 계좌 연결을 확인하세요.\n${assigned.issues.join("\n")}`);
  actual = assigned.movements;
  const l = layout(previous); const name = sheetDate(reportDate);
  if (book.getWorksheet(name)) throw new Error(`${name} 시트가 이미 있습니다. 기존 시트를 덮어쓰지 않습니다.`);
  const s = book.addWorksheet(name); const id = s.id;
  const model = structuredClone(previous.model);
  s.model = { ...model, id, name };
  // ExcelJS 4.4 serializes `merges` but its model setter reads `mergeCells`.
  for (const range of model.merges) s.mergeCellsWithoutStyle(range);
  // The model setter skips merged child cells, whose styles carry the outside edges.
  previous.eachRow({ includeEmpty: true }, (row) => row.eachCell({ includeEmpty: true }, (cell) => { s.getCell(cell.address).style = structuredClone(cell.style); }));
  const calculated = (address: string, expression: string, value: Amount) => formula(s, address, previous.getCell(address).formula || expression, value.round());
  const rolloverChecks = [...rollovers.keys()];
  for (const [address, expression] of rollovers) s.getCell(address).value = { formula: expression };
  s.getCell("B2").value = `일 일 자 금 일 보\n${reportDate.replaceAll("-", ".")}`;
  s.getCell("M19").value = `${reportDate} 최초 고시`;
  s.getCell(`M${l.fxHeader}`).value = { formula: previous.getCell(`M${l.fxHeader}`).formula || "M19", result: `${reportDate} 최초 고시` };
  for (const row of [...cashRows, ...l.termRows, ...l.otherRows]) {
    const opening = amounts[`H${row}`] ?? new Money(0);
    // Keep the template's ='전일'!H{row} carry-over, re-pointed at this report's prior sheet, whenever its cached value is the amount used.
    if (carriesPrior(previous, row, opening)) formula(s, `D${row}`, `ROUND('${previous.name}'!H${row},0)`, opening); else numeric(s.getCell(`D${row}`), opening);
    numeric(s.getCell(`E${row}`), 0); numeric(s.getCell(`G${row}`), 0);
    calculated(`H${row}`, `D${row}+E${row}-G${row}`, opening);
    if (currencyAt(row, l) !== "KRW") numeric(s.getCell(`I${row}`), amounts[`I${row}`] ?? new Money(0));
  }
  for (const row of l.activeTerms) if (maturity(previous, row) <= reportDate) {
    numeric(s.getCell(`G${row}`), amounts[`H${row}`]); calculated(`H${row}`, `D${row}+E${row}-G${row}`, new Money(0));
    if (currencyAt(row, l) !== "KRW") numeric(s.getCell(`I${row}`), 0);
    if (amounts[`H${row}`].gt(0)) s.getRow(row).hidden = false;
  }
  // The KC side table (header + every account row) must be readable in the PNG, so unhide it even if the previous sheet collapsed those rows.
  s.getRow(l.businessRows[0] - 1).hidden = false;
  for (const row of l.businessRows) { numeric(s.getCell(`P${row}`), 0); s.getRow(row).hidden = false; }
  for (const account of accounts) {
    const target = bindings.get(account.key)!; const row = Number(target.slice(1)); numeric(s.getCell(target), account.balance);
    s.getCell(target).note = `출처: 자금현황표/${account.source}; 계좌키 ${account.key}; 계좌잔고(O열)`;
    if (target[0] !== "H") continue;
    if (l.termRows.includes(row) && !l.activeTerms.includes(row)) {
      s.getCell(`A${row}`).value = `${sheetDate(account.start!)}~${sheetDate(account.maturity!)}`;
      s.getCell(`C${row}`).value = account.bank;
      s.getRow(row).hidden = false;
    }
    const flow = changes[account.key] ?? account;
    numeric(s.getCell(`E${row}`), flow.incoming); numeric(s.getCell(`G${row}`), flow.outgoing);
    if (l.activeTerms.includes(row) && maturity(previous, row) <= reportDate) { numeric(s.getCell(`G${row}`), amounts[`H${row}`]); numeric(s.getCell(`E${row}`), 0); }
    // 입력 금액을 반올림한 뒤에도 계좌잔고와 일치해야 하며, 차이를 임의로 증감에 넣지 않는다.
    const closingAmount = money(s.getCell(`D${row}`)).plus(money(s.getCell(`E${row}`))).minus(money(s.getCell(`G${row}`)));
    if (!sameWon(closingAmount, account.balance)) throw new Error(`${account.key}: 전일금액+증가-감소와 계좌잔고가 일치하지 않습니다.`);
    if (currencyAt(row, l) !== "KRW") numeric(s.getCell(`I${row}`), account.bookKrw);
    calculated(target, `D${row}+E${row}-G${row}`, closingAmount);
  }
  const totalRows: Record<number, number[]> = { 42: [35, 36, 37, 38, 39, 40, 41], 47: [46], [l.trustSum]: l.trustRows, 14: [10, 11, 12, 13], 16: [15], 17: [9, 14, 16], 22: [21], 25: [23, 24], 27: [26], 29: [28], 31: [30], [l.krwTermSum]: l.krwTermRows, [l.fxTermSum]: l.fxTermRows };
  for (const [target, children] of Object.entries(totalRows)) for (const col of ["D", "E", "G", "H", ...([22, 25, 27, 29, 31, l.fxTermSum].includes(Number(target)) ? ["I"] : [])]) {
    const vals = children.map((r) => { const v = raw(s.getCell(`${col}${r}`)); return v == null ? new Money(0) : money(s.getCell(`${col}${r}`)); });
    const cells = children.map((r) => `${col}${r}`);
    // 일부 원본의 CNY 소계가 JPY 행까지 참조하므로 통화 경계는 유지한다.
    const expression = [l.krwTermSum, l.fxTermSum, l.trustSum].includes(Number(target)) ? `SUM(${cells.join(",")})` : cells.join("+");
    if (Number(target) === 27) formula(s, `${col}${target}`, expression, sum(vals)); else calculated(`${col}${target}`, expression, sum(vals));
  }
  for (const row of [...cashRows.filter((r) => currencyAt(r, l) !== "KRW"), ...l.fxTermRows]) {
    const c = currencyAt(row, l) as keyof Rates["perUnit"]; const balance = money(s.getCell(`H${row}`)); const cost = money(s.getCell(`I${row}`)); const rate = new Money(rates.perUnit[c]);
    if (previous.getCell(`K${row}`).formula) formula(s, `K${row}`, previous.getCell(`K${row}`).formula, rate); else s.getCell(`K${row}`).value = rate.toNumber();
    const bookRate = previous.getCell(`J${row}`).formula || `I${row}/H${row}`;
    formula(s, `J${row}`, /^IFERROR\(/i.test(bookRate) ? bookRate : `IFERROR(${bookRate},0)`, balance.eq(0) ? new Money(0) : cost.div(balance));
    formula(s, `L${row}`, integerFormula(previous.getCell(`L${row}`).formula || `H${row}*K${row}`), balance.mul(rate).round());
    calculated(`M${row}`, `L${row}-I${row}`, balance.mul(rate).round().minus(cost));
  }
  const shortDate = (v: string) => `${Number(v.slice(5, 7))}/${Number(v.slice(8))}`;
  const executionCells = new Map<string, string[]>();
  for (const [items, descCol, amountCol, labelCol, day] of [[actual, "B", "D", "A", reportDate], [plan, "F", "H", "E", workDate]] as const) {
    s.getCell(`${labelCol}${l.opening}`).value = `기초금액(${shortDate(day)})`; s.getCell(`${labelCol}${l.closing}`).value = `마감잔액(${shortDate(day)})`;
    for (let r = l.opening + 1; r < l.closing; r++) {
      if (r === l.inSum || r === l.outSum) continue;
      const description = s.getCell(`${descCol}${r}`), adjacent = s.getCell(r, Number(description.col) + 1);
      description.value = null; if (!adjacent.isMerged) adjacent.value = null;
      const amount = s.getCell(`${amountCol}${r}`); numeric(amount, 0); if (amount.note) amount.note = "";
      for (const cell of [description, adjacent, amount]) {
        cell.font = { name: "맑은 고딕", size: 11, color: { argb: "FF000000" } };
        cell.alignment = { ...cell.alignment, vertical: "middle", wrapText: false, shrinkToFit: false };
      }
      description.alignment.horizontal = "left";
      s.getRow(r).height = Math.max(s.getRow(r).height ?? s.properties.defaultRowHeight ?? 15, 18);
    }
    for (const direction of ["in", "out"] as const) {
      const entries = items.filter((m) => m.direction === direction); const first = direction === "in" ? l.opening + 1 : l.inSum + 1; const last = direction === "in" ? l.inSum - 1 : l.closing - 2;
      if (entries.length > last - first + 1) throw new Error("집행내역이 고정 양식의 행 수를 초과합니다. 양식 확장이 필요합니다.");
      entries.forEach((m, i) => {
        const r = first + i; s.getCell(`${descCol}${r}`).value = `${m.description}${m.party ? ` / ${m.party}` : ""}`.replace(/[\r\n]+/g, " "); numeric(s.getCell(`${amountCol}${r}`), m.amount); s.getCell(`${amountCol}${r}`).note = m.source; s.getRow(r).hidden = false;
        if (amountCol === "D") {
          const target = `${direction === "in" ? "E" : "G"}${m.account!.slice(1)}`;
          executionCells.set(target, [...(executionCells.get(target) ?? []), `D${r}`]);
        }
      });
      calculated(`${amountCol}${direction === "in" ? l.inSum : l.outSum}`, `SUM(${amountCol}${first}:${amountCol}${last})`, sum(entries.map((m) => m.amount.round())));
    }
  }
  calculated(`D${l.opening}`, "D17", money(s.getCell("D17"))); calculated(`H${l.opening}`, `D${l.closing}`, money(s.getCell("H17")));
  for (const col of ["D", "H"]) calculated(`${col}${l.closing}`, `${col}${l.opening}+${col}${l.inSum}-${col}${l.outSum}`, money(s.getCell(`${col}${l.opening}`)).plus(money(s.getCell(`${col}${l.inSum}`))).minus(money(s.getCell(`${col}${l.outSum}`))));
  if (!money(s.getCell(`D${l.closing}`)).eq(money(s.getCell("H17")))) throw new Error("주요 집행내역의 마감잔액과 단기성 원화 금일금액이 다릅니다.");
  const bValues = accounts.filter((a) => bindings.get(a.key)?.startsWith("P"));
  const businessKrw = sum(bValues.filter((a) => a.currency === "KRW").map((a) => a.balance.round()));
  const businessFx = sum(bValues.filter((a) => a.currency !== "KRW").map((a) => a.balance.round().mul(rates.perUnit[a.currency as keyof Rates["perUnit"]]))).round();
  const holdingFx = sum(cashRows.filter((r) => currencyAt(r, l) !== "KRW").map((r) => money(s.getCell(`L${r}`))));
  const termFx = sum(l.fxTermRows.map((r) => money(s.getCell(`L${r}`))));
  const totals = [[holdingFx, money(s.getCell("H17"))], [businessFx, businessKrw], [termFx, money(s.getCell(`H${l.krwTermSum}`))]];
  totals.push([sum(totals.map((v) => v[0])), sum(totals.map((v) => v[1]))]);
  const businessCells = (currency: KcAccount["currency"]) => l.businessRows.filter((r) => (text(s.getCell(`O${r}`)).match(/USD|JPY|CNY/)?.[0] ?? "KRW") === currency).map((r) => `P${r}`);
  const totalStart = l.total - 6;
  const totalFormulas = [
    [`SUM(${cashRows.filter((r) => currencyAt(r, l) !== "KRW").map((r) => `L${r}`).join(",")})`, "H17"],
    [["USD", "JPY", "CNY"].map((code, i) => `SUM(${businessCells(code as KcAccount["currency"]).join(",") || "0"})*K${[21, 23, 26][i]}`).join("+"), `SUM(${businessCells("KRW").join(",") || "0"})`],
    [`SUM(L${l.fxTermRows[0]}:L${l.fxTermRows.at(-1)})`, `H${l.krwTermSum}`],
    [`F${totalStart}+F${totalStart + 2}+F${totalStart + 4}`, `G${totalStart}+G${totalStart + 2}+G${totalStart + 4}`],
  ];
  totals.forEach(([fx, krw], i) => {
    const row = totalStart + i * 2;
    formula(s, `F${row}`, integerFormula(previous.getCell(`F${row}`).formula || totalFormulas[i][0]), fx);
    calculated(`G${row}`, totalFormulas[i][1], krw); calculated(`H${row}`, `F${row}+G${row}`, fx.plus(krw)); s.getRow(row).hidden = false;
  });
  for (const row of [...cashRows, ...l.termRows, ...l.otherRows]) {
    for (const col of ["E", "G", "I"]) {
      const original = previous.getCell(`${col}${row}`), target = s.getCell(original.address);
      if (cashRows.includes(row) && row < 20 && col !== "I") {
        formula(s, target.address, `SUM(${executionCells.get(target.address)?.join(",") || "0"})`, money(target));
        continue;
      }
      if (!original.formula || (col === "I" && (typeof raw(original) !== "number" || !money(original).round().eq(money(target))))) continue;
      formula(s, target.address, col === "I" ? integerFormula(original.formula) : original.formula, money(target));
    }
  }
  s.eachRow((row) => row.eachCell((cell) => {
    if (cell.isMerged && cell.master.address !== cell.address) return;
    const value = raw(cell);
    if (typeof value !== "number") return;
    const rate = [10, 11].includes(Number(cell.col)) && [...cashRows, ...l.fxTermRows].includes(row.number) && currencyAt(row.number, l) !== "KRW";
    if (!rate && !cell.formula) numeric(cell, value);
    cell.numFmt = rate ? "#,##0.########" : "#,##0;-#,##0;0";
    cell.alignment = { ...cell.alignment, horizontal: "right", wrapText: false };
  }));
  const lastRow = Math.max(l.total, l.businessRows.at(-1) ?? 0);
  let lastCol = 1;
  s.eachRow((row, r) => { if (r <= lastRow) row.eachCell((cell, c) => { if (cell.value !== null) lastCol = Math.max(lastCol, c); }); });
  s.pageSetup.printArea = `A1:${s.getCell(lastRow, lastCol).address}`; s.state = "visible";
  Object.assign(s.pageSetup, { fitToPage: true, fitToWidth: 1, fitToHeight: 1 });
  book.calcProperties.fullCalcOnLoad = true;
  return { sheet: s, totalKrw: totals[3][1], rolloverChecks };
}
