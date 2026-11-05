import { createHash } from "node:crypto";
import { z } from "zod";
import type { BusinessTool, ToolResult } from "./contracts.ts";
import type { BusinessField } from "../../src/app-types/BusinessTool.types.ts";
import { loadWorkbook } from "../work/mapping.ts";
import { SelectiveWorkbook } from "../work/selectiveWorkbook.ts";
import { differences, parseOverrides } from "./dailyCash/cashStatus.ts";
import { CAPER_CASH_URL, fetchErpCashStatus, readErpCashStatus, type ErpCashSnapshot } from "./dailyCash/erp.ts";
import { fetchHana, type Rates } from "./dailyCash/hana.ts";
import { renderSheet } from "./dailyCash/image.ts";
import { bindAccounts, buildReport, cashRows, depositIssues, layout, maturity, priorAmounts, rolloverFormulas } from "./dailyCash/report.ts";
import { date, decimal, isoSheetDate, money, sameWon, sheetDate, shiftDate, previousBusinessDay, sum, text, type Amount } from "./dailyCash/values.ts";
import { depositKind, readWeekly, type Movement } from "./dailyCash/weekly.ts";

/** The input card renders these as an editable table and submits the same {changes, add} JSON that applyEdits reads. */
const movementField = (key: string, label: string, plan: Movement[]): Partial<BusinessField> & { key: string; label: string } => ({ key, label, type: "movements", rows: plan.map((m, i) => ({ index: i + 1, direction: m.direction, description: m.description, party: m.party, amount: m.amount.toFixed() })) });
/** flow가 한 번에 받는 입력란 상한(30) 안에서 셀별 숫자 입력을 제공한다. 그보다 많으면 파일 자체가 계산값 없이 저장된 것이다. */
const MAX_CELL_INPUTS = 20;
const numberInput = z.union([z.number(), z.string()]);
const editsSchema = z.object({ changes: z.array(z.object({ index: z.number().int().min(1), amount: numberInput, description: z.string().optional(), party: z.string().optional() }).strict()).max(200).default([]), add: z.array(z.object({ direction: z.enum(["in", "out"]), description: z.string().min(1), party: z.string().default(""), amount: numberInput }).strict()).max(200).default([]) }).strict();
export function applyEdits(plan: Movement[], input: string | undefined, day: string): Movement[] {
  if (!input || input === "확인") return plan.map((m) => ({ ...m }));
  const edits = editsSchema.parse(JSON.parse(input)); const items = plan.map((m) => ({ ...m })); const seen = new Set<number>();
  for (const edit of edits.changes) {
    if (!items[edit.index - 1] || seen.has(edit.index)) throw new Error("수정할 계획 번호가 없거나 중복됩니다."); seen.add(edit.index);
    const amount = decimal(edit.amount, "수정 금액"); if (amount.lt(0)) throw new Error("수정 금액은 0 이상이어야 합니다. 0은 미집행입니다.");
    items[edit.index - 1] = { ...items[edit.index - 1], ...edit, amount, source: `담당자 확인·수정 / 원계획 ${items[edit.index - 1].source}` };
  }
  for (const entry of edits.add) { const amount = decimal(entry.amount, "추가 금액"); if (amount.lte(0)) throw new Error("추가 금액은 양수여야 합니다."); items.push({ ...entry, amount, date: day, source: "담당자 확인 추가 거래" }); }
  return items.filter((m) => m.amount.gt(0));
}
/** Fallback when the Hana page cannot be read even after a retry: the person types the published 매매기준율 and the audit records it as manual. */
const MANUAL_RATE_FIELDS: BusinessField[] = [
  { key: "manualRateDate", label: "고시 기준일 (하나은행 화면의 기준일)", type: "date", required: true },
  { key: "manualRateRound", label: "고시 회차", type: "text", required: false },
  { key: "manualUSD", label: "USD 매매기준율 (1달러당 원)", type: "number", required: true },
  { key: "manualJPY100", label: "JPY 매매기준율 (100엔당 원)", type: "number", required: true },
  { key: "manualCNY", label: "CNY 매매기준율 (1위안당 원)", type: "number", required: true },
];
function manualRates(values: Record<string, string>, reportDate: string): Rates {
  const positive = (key: string) => { const amount = decimal(values[key], key); if (amount.lte(0)) throw new Error(`${key}는 양수여야 합니다.`); return amount; };
  return { date: date(values.manualRateDate), requestedDate: reportDate, round: values.manualRateRound?.trim() || "수동", publishedAt: "담당자 수동 입력", source: "담당자 수동 입력 (하나은행 고시환율 화면 확인)", fetchedAt: new Date().toISOString(), responseHash: "manual", perUnit: { USD: positive("manualUSD").toString(), JPY: positive("manualJPY100").div(100).toString(), CNY: positive("manualCNY").toString() } };
}
const markdownText = (value: string) => value.replace(/([\\`*_{}[\]<>])/g, "\\$1").replace(/[\r\n]+/g, " ");
const bullets = (items: string[]) => items.map((item) => `- ${markdownText(item)}`).join("\n");
const listing = (items: Movement[]) => items.length ? items.map((m) => `- **${m.direction === "in" ? "입금" : "지급"} ${m.amount.toFixed()}원** · ${markdownText(m.description)}${m.party ? ` / ${markdownText(m.party)}` : ""}`).join("\n") : "해당일 지주현금 계획 없음";
const correctionHelp = '표에서 실제 금액을 고치고(미집행은 0) 계획에 없는 거래는 행을 추가하세요.';

export const dailyCashTool: BusinessTool = {
  id: "daily_cash", version: "1.2.0", title: "일일자금일보",
  updateSource: "previousReport",
  description: "전일 일보·주간계획과 ERP에서 조회한 KC 자금현황으로 작업일 직전 영업일(주말·공휴일 제외) 기준 일일자금일보 시트와 PNG를 생성한다. 지주현금 계획의 실제 집행을 담당자가 확인하고 계좌잔고 및 총 원화를 대사한다.",
  examples: ["일일자금일보 작성해줘", "어제 기준 자금일보와 이미지 만들어줘"],
  requiredInputs: ["작업일", "전일 일보가 있는 XLSX", "해당 주 주간자금계획"],
  initialQuestion: "작업일과 전일 일보·주간자금계획을 지정해 주세요. KC 자금현황은 ERP에서 자동 조회합니다.",
  fields: [
    { key: "workDate", label: "작업일 (예: 29일 선택 → 28일 기준 일보, 월요일·공휴일 다음 날은 직전 영업일)", type: "date", required: true },
    { key: "previousReport", label: "전일 일보가 있는 통합문서", type: "file", required: true },
    { key: "weeklyPlans", label: "주간자금계획 (주 경계에서는 해당 두 주)", type: "file", multiple: true, required: true },
  ],
  defaults: (today) => ({ workDate: today }),
  uploadOnly: true,
  async execute(input) {
    const { values, files, signal } = input; const checkpoint = { ...input.checkpoint };
    const ask = (question: string, fields: (Partial<BusinessField> & { key: string; label: string })[], state = checkpoint): ToolResult => ({ status: "needs_input", question, fields: fields.map((f) => ({ ...f, type: f.type ?? "text", required: f.required ?? true })), checkpoint: state });
    try {
      signal.throwIfAborted();
      const workDate = date(values.workDate); const reportDate = previousBusinessDay(workDate);
      if (workDate > new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" })) throw new Error("미래 작업일의 최종 환율과 실제 잔고는 확정할 수 없습니다.");
      if (files.previousReport?.length !== 1) throw new Error("전일 일보 파일 하나를 지정하세요.");
      if (!files.weeklyPlans?.length) throw new Error("주간계획 파일이 필요합니다.");
      const archive = await SelectiveWorkbook.open(files.previousReport[0].bytes);
      if (archive.sheetNames.includes(sheetDate(reportDate))) throw new Error(`${sheetDate(reportDate)} 시트가 이미 있습니다. 중복 생성하지 않습니다.`);
      const priorName = archive.sheetNames.filter((name) => /^\d{6}$/.test(name) && isoSheetDate(name) < reportDate).sort().at(-1);
      if (!priorName) throw new Error("기준일보다 앞선 날짜의 전일 일보 시트가 없습니다.");
      const priorDate = isoSheetDate(priorName);
      if (priorDate < shiftDate(reportDate, -7)) throw new Error(`전일 일보가 너무 오래되었습니다 (${priorDate}). ${reportDate} 직전 마감 일보가 포함된 파일로 새 작업을 시작하세요.`);
      if (priorDate !== previousBusinessDay(reportDate) && values.carryConfirmation !== "확인") return ask(`${priorDate} 마감 금액을 ${reportDate}의 전일금액으로 이월합니다. 휴무일 동안 거래가 없고 마지막 마감 일보가 맞으면 확인하고 계속하세요.`, [{ key: "carryConfirmation", label: "휴무일 거래 없음 · 마지막 마감 일보 확인", confirm: "확인" }]);
      const [book, ...weeks] = await Promise.all([archive.loadSheet(priorName), ...files.weeklyPlans.map((f) => loadWorkbook(f.bytes))]);
      const candidate = book.getWorksheet(priorName)!;
      if (!checkpoint.erpCash) checkpoint.erpCash = await fetchErpCashStatus(workDate, signal);
      const kc = readErpCashStatus(checkpoint.erpCash, workDate); const l = layout(candidate);
      const erp = checkpoint.erpCash as ErpCashSnapshot;
      const erpSource = { endpoint: CAPER_CASH_URL, from_dt: erp.from_dt, to_dt: erp.to_dt, fetchedAt: erp.fetchedAt, responseHash: erp.responseHash, rowCount: erp.rows.length, truncated: false };
      const weekly = weeks.map((b, i) => readWeekly(b, files.weeklyPlans[i].name));
      for (const day of [reportDate, workDate]) {
        const selected = weekly.filter((w) => w.dates.has(day));
        if (selected.length > 1) throw new Error(`${day} 주간계획이 여러 파일에 중복됩니다. 사용할 버전 하나만 지정하세요.`);
        if (!selected.length && values.noPlanDates !== `${reportDate},${workDate}`) return ask(`주간계획에 ${day} 날짜가 없습니다. 파일의 내부 날짜를 확인하세요. 휴무일 등으로 해당 날짜 계획이 없다면 확인하고 계속하세요. 잘못된 주 파일이면 새 작업에서 교체하세요.`, [{ key: "noPlanDates", label: `${reportDate}·${workDate} 지주현금 계획 없음`, confirm: `${reportDate},${workDate}` }]);
      }
      const cellField = (cell: string): BusinessField => ({ key: `cell_${cell}`, label: `${candidate.name}!${cell} ${cell.startsWith("I") ? "장부금액" : "금일금액"} (${text(candidate.getCell(`C${cell.slice(1)}`)) || "항목 없음"})`, type: "number", required: true });
      let overrides: Record<string, Amount>;
      try { overrides = parseOverrides(values.previousValues); }
      catch { return ask("이전에 입력한 전일 금액을 읽을 수 없습니다. 아래 버튼으로 해당 보정값을 초기화한 뒤, 필요한 금액을 셀별 입력란에 다시 작성해 주세요.", [{ key: "previousValues", label: "이전 전일 금액 보정 초기화", confirm: "{}" }]); }
      const invalidCells: string[] = [];
      for (const [key, value] of Object.entries(values)) {
        const cell = key.match(/^cell_([HI]\d{1,3})$/)?.[1];
        if (!cell) continue;
        try { overrides[cell] = decimal(value, cell); } catch { invalidCells.push(cell); }
      }
      if (invalidCells.length) return ask("전일 금액은 빈칸 없이 숫자로 입력해 주세요. 확인한 금액이 0이면 0을 입력하세요.", invalidCells.map(cellField));
      const previous = priorAmounts(candidate, overrides);
      if (previous.missing.length > MAX_CELL_INPUTS) {
        throw new Error(`전일 일보에서 수식의 저장 결과가 없는 셀이 ${previous.missing.length}개입니다 (${previous.missing.slice(0, 12).join(", ")} …). Excel에서 열어 수식을 계산하고 저장한 원본 파일로 새 작업을 시작하세요. 빈 금액을 0으로 추정하지 않습니다.`);
      }
      if (previous.missing.length) return ask(`전일 일보에서 수식의 저장 결과가 없는 셀이 있습니다. 전일 일보 ${candidate.name} 시트에서 확인한 금액을 셀별로 입력하세요. 0으로 추정하지 않습니다.`, previous.missing.map(cellField));
      let explicit: Record<string, string>;
      const bindingField = (accounts = kc.accounts): BusinessField => ({ key: "accountBindings", label: "계좌별 전일 일보 연결", type: "text", required: true,
        accountRows: accounts.map((a) => ({ key: a.key, name: a.name, currency: a.currency, balance: a.balance.toFixed(), maturity: a.maturity })) });
      try { explicit = values.accountBindings ? z.record(z.string(), z.string().regex(/^[HP]\d{1,3}$/)).parse(JSON.parse(values.accountBindings)) : {}; } catch { return ask("계좌 연결 위치를 읽을 수 없습니다. 아래 계좌별로 일보 영역과 행 번호를 다시 입력해 주세요.", [bindingField()]); }
      const { bindings, unresolved } = bindAccounts(candidate, kc.accounts, previous.values, explicit, reportDate);
      if (unresolved.length) {
        const accounts = kc.accounts.filter((a) => !bindings.has(a.key));
        const details = bullets(unresolved);
        if (!accounts.length) throw new Error(`전일 일보에 대응하는 KC 계좌가 없는 금액이 있습니다. 누락된 계좌 또는 전일 일보를 확인하고 갱신된 파일로 새 작업을 시작하세요.\n${details}`);
        return ask(`전일 일보 **${priorName}** 시트에서 아래 계좌가 기록된 위치를 확인해 주세요. 은행·통화·원금·만기일이 같은 계좌인지 확인한 뒤, **일보 영역**과 **행 번호**를 입력하세요. 예를 들어 H12 셀이면 H열과 12행을 선택합니다. H열은 본표의 금일금액, P열은 사업부문 자금현황표(KC)의 잔고입니다.\n\n${details}\n\n예금 만기가 양쪽 자료에서 다르면 갱신된 전일 일보로 새 작업을 시작해야 합니다.`, [bindingField(accounts)]);
      }
      const planActual = weekly.flatMap((w) => w.movements).filter((m) => m.date === reportDate);
      const planNext = weekly.flatMap((w) => w.movements).filter((m) => m.date === workDate);
      const planDeposits = weekly.flatMap((w) => w.deposits).filter((m) => m.date === reportDate);
      const depositField = () => movementField("depositEdits", `${reportDate} 정기예금 집행 (입금: 만기 원금·이자 / 지급: 가입 원금)`, planDeposits);
      if (!values.actualEdits || !values.planEdits || (planDeposits.length && !values.depositEdits)) return ask(`### 집행 내역 확인\n\n자금현황표에는 개별 거래 적요가 없습니다. 아래 표를 확인·수정한 뒤 실행하세요.\n\n- **${reportDate} 실적:** 실제 집행 금액을 입력하세요. 미집행은 **0**으로 바꾸고, 계획에 없던 거래는 추가하세요.\n- **${workDate} 계획:** 예정된 거래와 금액을 확인하세요.\n- **정기예금 집행:** 지주현금 실적과 별도로 확인합니다. 이자는 예금 원금 증감에서 제외합니다.`, [movementField("actualEdits", `${reportDate} 실적`, planActual), movementField("planEdits", `${workDate} 계획`, planNext), ...(planDeposits.length ? [depositField()] : [])]);
      let actual: Movement[], nextPlan: Movement[], deposits: Movement[];
      try {
        actual = applyEdits(planActual, values.actualEdits, reportDate); nextPlan = applyEdits(planNext, values.planEdits, workDate); deposits = applyEdits(planDeposits, values.depositEdits, reportDate);
        if (deposits.some((m) => !depositKind(m))) throw new Error("정기예금 집행은 입금 '정기예금 만기 원금/이자', 지급 '정기예금 가입' 적요만 허용합니다.");
      } catch (e) { return ask(`${e instanceof SyntaxError || e instanceof z.ZodError ? "거래 입력을 읽을 수 없습니다. 아래 표에서 실제 금액과 추가 거래를 다시 확인해 주세요." : String(e)}\n${correctionHelp}`, [movementField("actualEdits", `${reportDate} 실적`, planActual), movementField("planEdits", `${workDate} 계획`, planNext), depositField()]); }
      const termIssues = depositIssues(candidate, previous.values, kc.accounts, bindings, [...actual, ...deposits], reportDate);
      if (termIssues.length) return ask(`### 정기예금 집행 확인\n\n정기예금 원금과 실제 집행 내역이 맞지 않습니다. **이자는 원금에 합산하지 않습니다.**\n\n${bullets(termIssues)}\n\n${correctionHelp}`, [depositField(), movementField("actualEdits", `${reportDate} 실적`, planActual)]);
      const cashAccounts = kc.accounts.filter((a) => bindings.get(a.key)?.startsWith("H") && cashRows.includes(Number(bindings.get(a.key)!.slice(1))));
      const cashField: BusinessField = { key: "cashChanges", label: "계좌별 실제 입금·출금", type: "text", required: true,
        cashRows: cashAccounts.map((a) => ({ key: a.key, name: a.name, currency: a.currency, opening: previous.values[bindings.get(a.key)!].toFixed(), balance: a.balance.toFixed() })) };
      const changes: Record<string, { incoming: Amount; outgoing: Amount }> = {};
      try {
        const parsed = values.cashChanges ? z.record(z.string(), z.object({ incoming: numberInput, outgoing: numberInput }).strict()).parse(JSON.parse(values.cashChanges)) : {};
        for (const [key, flow] of Object.entries(parsed)) { if (!bindings.get(key)?.startsWith("H") || !cashRows.includes(Number(bindings.get(key)!.slice(1)))) throw new Error("입출금 보정은 연결된 단기성 계좌만 허용합니다."); const incoming = decimal(flow.incoming, key); const outgoing = decimal(flow.outgoing, key); if (incoming.lt(0) || outgoing.lt(0)) throw new Error("입출금은 0 이상이어야 합니다."); changes[key] = { incoming, outgoing }; }
      } catch { if (!cashAccounts.length) throw new Error("입출금을 보정할 단기성 계좌가 없습니다. 원천 파일을 확인하고 새 작업을 시작하세요."); return ask("계좌별 실제 입금·출금 금액을 확인해 주세요. 연결된 단기성 계좌에 대해 0 이상의 숫자를 입력하세요. 거래가 없으면 0을 입력하고, 확인하지 못한 금액은 추정하지 마세요.", [cashField]); }
      const flowIssues: string[] = []; const matured = l.activeTerms.filter((row) => maturity(candidate, row) <= reportDate && !previous.values[`H${row}`].isZero()).map((row) => `일보 H${row}: ${previous.values[`H${row}`]} 감소, 만기 ${maturity(candidate, row)}`);
      for (const a of kc.accounts) {
        const target = bindings.get(a.key)!; if (target[0] !== "H") continue;
        const row = Number(target.slice(1)); const opening = previous.values[target]; const flow = changes[a.key] ?? a;
        if (l.activeTerms.includes(row) && maturity(candidate, row) <= reportDate) { if (!a.balance.eq(0)) flowIssues.push(`${a.key}: 만기 도래했지만 계좌잔고가 ${a.balance}입니다. 만기 입금/연장 내역을 확인해 원천을 정정하세요.`); continue; }
        if (!sameWon(opening.plus(flow.incoming).minus(flow.outgoing), a.balance)) flowIssues.push(`${a.key}: 전일일보 ${opening} + 입금 ${flow.incoming} - 지급 ${flow.outgoing} ≠ 계좌잔고 ${a.balance} (장부잔액 ${a.ledger})`);
      }
      if (flowIssues.length) {
        const message = `장부와 실제 잔고 차이/전일 이월을 확인하세요. 차이를 임의로 지급 처리하지 않습니다. 아래 계좌별로 확인한 실제 입금 총액과 출금 총액을 입력하세요. 거래가 없으면 0을 입력하세요.\n${flowIssues.join("\n")}`;
        if (!cashAccounts.length) throw new Error(`입출금 보정으로 해결할 수 없는 예금 잔고입니다. 만기·가입 내역과 원천 파일을 확인하고 새 작업을 시작하세요.\n${flowIssues.join("\n")}`);
        return ask(message, [cashField, movementField("actualEdits", `${reportDate} 실적`, planActual)]);
      }
      const holdingOpening = sum(cashRows.filter((r) => r < 20).map((r) => previous.values[`H${r}`]));
      const holdingClosing = sum(kc.accounts.filter((a) => bindings.get(a.key)?.startsWith("H") && cashRows.includes(Number(bindings.get(a.key)!.slice(1))) && a.currency === "KRW").map((a) => a.balance));
      const actualClosing = holdingOpening.plus(sum(actual.filter((m) => m.direction === "in").map((m) => m.amount))).minus(sum(actual.filter((m) => m.direction === "out").map((m) => m.amount)));
      if (!sameWon(actualClosing, holdingClosing)) return ask(`실적 내역과 원화 계좌잔고가 맞지 않습니다. 전일 ${holdingOpening} → 실적 반영 ${actualClosing}, 계좌잔고 ${holdingClosing}, 차이 ${actualClosing.minus(holdingClosing)}원. 추가/변경/미집행 내역을 확인하세요.\n\n### 확인할 실적\n\n${listing(actual)}\n\n${correctionHelp}`, [movementField("actualEdits", `${reportDate} 실적`, planActual)]);
      let rates = checkpoint.rates as Rates | undefined;
      if (!rates || rates.requestedDate !== reportDate) {
        if (values.manualRateDate) {
          try { rates = manualRates(values, reportDate); } catch (e) { return ask(`수동 입력한 환율을 확인하세요: ${String(e)}`, MANUAL_RATE_FIELDS, checkpoint); }
          checkpoint.rates = rates;
        } else {
          try { rates = await fetchHana(reportDate, signal); checkpoint.rates = rates; }
          catch (e) {
            signal.throwIfAborted();
            if (values.retryRates !== "확인") return ask(`하나은행 기준일 최종 고시를 조회하지 못했습니다: ${String(e)}. 네트워크를 확인한 뒤 재시도해 주세요. 환율을 추정하여 완성하지 않습니다.`, [{ key: "retryRates", label: "하나은행 고시 재조회", confirm: "확인" }], checkpoint);
            return ask(`재조회도 실패했습니다: ${String(e)}. 하나은행 고시환율 화면에서 ${reportDate} 최종 고시의 매매기준율을 확인해 직접 입력하세요. 입력값은 "담당자 수동 입력"으로 작업 기록과 최종 확인에 기록됩니다.`, MANUAL_RATE_FIELDS, checkpoint);
          }
        }
      }
      if (rates.date !== reportDate && values.rateDateConfirmation !== rates.date) return ask(`하나은행이 요청일 ${reportDate} 대신 ${rates.date}의 고시를 반환했습니다(휴무일 등). 적용 가능한 고시일이면 확인하고 계속하세요.`, [{ key: "rateDateConfirmation", label: `${rates.date} 고시 적용`, confirm: rates.date }], checkpoint);
      const diff = differences(planActual, actual);
      const depositDiff = differences(planDeposits, deposits);
      const newDeposits = kc.accounts.filter((a) => a.product === "정기예금" && !l.activeTerms.includes(Number(bindings.get(a.key)!.slice(1)))).map((a) => ({ key: a.key, bank: a.bank, currency: a.currency, start: a.start, maturity: a.maturity, amount: a.incoming.toString(), target: bindings.get(a.key) }));
      const audit = { workDate, reportDate, priorSheet: candidate.name, sourceDate: reportDate, erpSource, rates, bindings: Object.fromEntries(bindings), previousOverrides: values.previousValues ?? null, cashChanges: values.cashChanges ?? null, actual: actual.map((m) => ({ ...m, amount: m.amount.toString() })), plan: nextPlan.map((m) => ({ ...m, amount: m.amount.toString() })), differences: diff, deposits: deposits.map((m) => ({ ...m, amount: m.amount.toString() })), depositDifferences: depositDiff, newDeposits, matured, kcTotal: kc.total.toString(), kcTotalSource: kc.totalSource, sources: Object.fromEntries(Object.entries(files).map(([key, list]) => [key, list.map((f) => ({ name: f.name, fingerprint: f.fingerprint }))])) };
      const review = createHash("sha256").update(JSON.stringify(audit)).digest("hex").slice(0, 12);
      if (values.review !== `확인 ${review}`) return ask([
        `### 최종 확인\n\n**작업일 ${workDate} → 일보 기준일 ${reportDate}**\n\n${candidate.name} 금일금액을 전일금액으로 이월합니다.`,
        "- 원천 수식의 저장된 계산 결과를 사용합니다. 재계산·저장이 완료된 자료인지 확인하세요.\n- 미매핑 빈 계좌 및 기타 채권·적금·신탁에 변동이 없는지 확인하세요.",
        `### 계좌 연결\n\n${bullets(kc.accounts.map((a) => `${a.key} → ${bindings.get(a.key)} (${a.name}, ${a.balance})`))}`,
        `### 계획 대비 실적 차이\n\n${diff.length ? diff.map((d) => `- ${markdownText(d.key.join(" / "))}: 계획 **${d.planned}원** → 실적 **${d.actual}원**`).join("\n") : "차이 없음 (담당자가 실제 집행 확인)"}`,
        `### 정기예금 집행\n\n**이자는 원금 증감에서 제외합니다.**\n\n${deposits.length ? listing(deposits) : "없음"}`,
        `### 신규 가입\n\n${bullets(newDeposits.map((a) => `${a.bank}: ${a.amount} ${a.currency}, ${a.start}~${a.maturity} → ${a.target}`)) || "없음"}`,
        `### 만기\n\n${bullets(matured) || "없음"}`,
        `### 원화 대사 및 환율\n\n- ERP 조회: ${erp.from_dt}~${erp.to_dt}, ${erp.rows.length}계좌, ${erp.fetchedAt} (이번 작업의 고정 조회 결과)\n- **원화 대사 대상: ${kc.total}원** (${markdownText(kc.totalSource)}, 계좌잔고)\n- 고시: ${rates.date} 최종 ${markdownText(rates.round)}회\n- USD ${rates.perUnit.USD}, JPY(1엔) ${rates.perUnit.JPY}, CNY ${rates.perUnit.CNY}`,
        "확정하려면 **확인하고 계속**을 누르세요. 표를 수정하면 새 확인 코드로 다시 확인합니다.",
      ].join("\n\n"), [{ key: "review", label: `최종 확인 코드 ${review}`, confirm: `확인 ${review}` }, movementField("actualEdits", `${reportDate} 실적`, planActual), movementField("planEdits", `${workDate} 계획`, planNext), ...(planDeposits.length || deposits.length || newDeposits.length ? [depositField()] : [])], checkpoint);
      const built = buildReport(book, candidate, reportDate, workDate, previous.values, kc.accounts, bindings, actual, nextPlan, rates, changes, await rolloverFormulas(archive, candidate));
      if (!sameWon(built.totalKrw, kc.total)) throw new Error(`총 원화 대사 불일치: 일보 ${built.totalKrw}, KC ${kc.total}, 차이 ${built.totalKrw.minus(kc.total)}. 결과를 발행하지 않습니다.`);
      signal.throwIfAborted();
      const prepared = await archive.appendSheet(book, built.sheet.name);
      const { bytes, image, sheet: calculated, engine, fallbackReason } = await renderSheet(prepared, built.sheet.name, built.rolloverChecks, signal, built.textFitRanges);
      const calculatedLayout = layout(calculated);
      if (!sameWon(money(calculated.getCell(`G${calculatedLayout.total}`)), kc.total) || !money(calculated.getCell(`D${calculatedLayout.closing}`)).eq(money(calculated.getCell("H17")))) throw new Error(`${engine} 재계산 후 총 원화 또는 주요 집행 마감잔액이 일치하지 않습니다.`);
      for (const account of kc.accounts) if (!sameWon(money(calculated.getCell(bindings.get(account.key)!)), account.balance)) throw new Error(`${account.key}: ${engine} 재계산 후 계좌 잔고가 일치하지 않습니다.`);
      signal.throwIfAborted();
      return { status: "completed", summary: `${reportDate} 기준 일보 시트 ${built.sheet.name}를 원본 통합문서에 추가했습니다. 총 원화 ${kc.total.toFixed()}원 대사 일치. 출력 엔진: ${engine}${fallbackReason ? " (Excel 출력 실패로 자동 전환)" : ""}.`, file: { name: files.previousReport[0].name, bytes }, validationSheet: built.sheet.name, image: { name: `일일자금일보_${sheetDate(reportDate)}.png`, bytes: image }, checks: [{ name: "전일금액 이월 및 계좌별 증감 대사", passed: true }, { name: "실적 확인 및 주요 집행 마감잔액 대사", passed: true }, { name: "총 원화 = KC 원화 계좌잔고 합계", passed: true }, { name: "정기예금 만기·가입 원금 대사 (이자 제외)", passed: true }, { name: "최종 환율·만기·계좌 연결 확인", passed: true }], externalData: { ...audit, outputEngine: engine, fallbackReason: fallbackReason ?? null } };
    } catch (error) { signal.throwIfAborted(); return { status: "failed", message: error instanceof Error ? error.message : String(error) }; }
  },
};
