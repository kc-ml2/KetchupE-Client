import { createHash } from "node:crypto";
import { z } from "zod";
import type { BusinessTool, ToolResult } from "./contracts.ts";
import type { BusinessField } from "../../src/app-types/BusinessTool.types.ts";
import { loadWorkbook } from "../work/mapping.ts";
import { readCashStatus, differences, parseOverrides } from "./dailyCash/cashStatus.ts";
import { fetchHana, type Rates } from "./dailyCash/hana.ts";
import { renderSheet } from "./dailyCash/image.ts";
import { bindAccounts, buildReport, cashRows, depositIssues, layout, maturity, priorAmounts } from "./dailyCash/report.ts";
import { date, decimal, isoSheetDate, sameWon, sheetDate, shiftDate, sum, text, type Amount } from "./dailyCash/values.ts";
import { depositKind, readWeekly, type Movement } from "./dailyCash/weekly.ts";

const ask = (question: string, fields: (Partial<BusinessField> & { key: string; label: string })[], checkpoint?: Record<string, unknown>): ToolResult => ({ status: "needs_input", question, fields: fields.map((f) => ({ ...f, type: f.type ?? "text", required: f.required ?? true })), checkpoint });
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
const markdownText = (value: string) => value.replace(/([\\`*_{}\[\]<>])/g, "\\$1").replace(/[\r\n]+/g, " ");
const bullets = (items: string[]) => items.map((item) => `- ${markdownText(item)}`).join("\n");
const listing = (items: Movement[]) => items.length ? items.map((m) => `- **${m.direction === "in" ? "입금" : "지급"} ${m.amount.toFixed()}원** · ${markdownText(m.description)}${m.party ? ` / ${markdownText(m.party)}` : ""}`).join("\n") : "해당일 지주현금 계획 없음";
const correctionHelp = '표에서 실제 금액을 고치고(미집행은 0) 계획에 없는 거래는 행을 추가하세요.';

export const dailyCashTool: BusinessTool = {
  id: "daily_cash", version: "1.1.0", title: "일일자금일보",
  updateSource: "previousReport",
  description: "전일 일보·주간계획·KC 자금현황표로 작업일 전날 기준 일일자금일보 시트와 PNG를 생성한다. 지주현금 계획의 실제 집행을 담당자가 확인하고 계좌잔고 및 총 원화를 대사한다.",
  examples: ["일일자금일보 작성해줘", "어제 기준 자금일보와 이미지 만들어줘"],
  requiredInputs: ["작업일", "전일 일보가 있는 XLSX", "해당 주 주간자금계획", "기준일(작업일 전날)의 자금현황표(KC)"],
  fields: [
    { key: "workDate", label: "작업일 (예: 29일 선택 → 28일 기준 일보)", type: "date", required: true },
    { key: "previousReport", label: "전일 일보가 있는 통합문서", type: "file", required: true },
    { key: "weeklyPlans", label: "주간자금계획 (주 경계에서는 해당 두 주)", type: "file", multiple: true, required: true },
    { key: "cashStatus", label: "기준일 자금현황표(KC) (작업일 전날 파일)", type: "file", required: true },
  ],
  suggest(files, today) {
    const reportDate = shiftDate(today, -1);
    const named = files.map((file) => ({ file, name: file.name.normalize("NFC"), stamp: file.name.normalize("NFC").match(/\d{4,6}/)?.[0] ?? "" }));
    const latest = (items: typeof named) => [...items].sort((a, b) => b.stamp.localeCompare(a.stamp))[0]?.file;
    // 일보 파일명의 YYMMDD는 마지막 시트 날짜이므로 기준일 전날 이하만 전일 일보 후보다. 연도 단위 파일(2026_일일자금일보_지주)은 4자리라 그대로 통과한다.
    const reports = named.filter((f) => /일일자금일보/.test(f.name) && !/샘플|업무흐름|테스트|검증/.test(f.name) && (f.stamp.length !== 6 || f.stamp <= sheetDate(shiftDate(reportDate, -1))));
    // ponytail: 주간계획 파일명 MMDD는 연도 경계를 무시한다. 기준일과 작업일이 다른 주에 걸치면 두 파일을 모두 채운다.
    const weekly = named.filter((f) => /주간자금계획/.test(f.name) && f.stamp.length === 4);
    const weekUpTo = (day: string) => latest(weekly.filter((f) => f.stamp <= sheetDate(day).slice(2)));
    const plans = [weekUpTo(reportDate), weekUpTo(today)].filter((file, index, all): file is NonNullable<typeof file> => Boolean(file) && all.indexOf(file) === index);
    const status = latest(named.filter((f) => f.name.startsWith(`${sheetDate(reportDate)}_`) && /자금현황표|KC/.test(f.name)));
    const pick = (file?: typeof files[number]) => file ? [file] : [];
    return { values: { workDate: today }, files: { previousReport: pick(latest(reports)), weeklyPlans: plans, cashStatus: pick(status) } };
  },
  async execute(input) {
    const { values, files, signal } = input; const checkpoint = { ...input.checkpoint };
    try {
      signal.throwIfAborted();
      const workDate = date(values.workDate); const reportDate = shiftDate(workDate, -1);
      if (workDate > new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" })) throw new Error("미래 작업일의 최종 환율과 실제 잔고는 확정할 수 없습니다.");
      for (const key of ["previousReport", "cashStatus"]) if (files[key]?.length !== 1) throw new Error(`${key}: 파일 하나를 지정하세요.`);
      if (!files.weeklyPlans?.length) throw new Error("주간계획 파일이 필요합니다.");
      const [book, statusBook, ...weeks] = await Promise.all([files.previousReport[0], files.cashStatus[0], ...files.weeklyPlans].map((f) => loadWorkbook(f.bytes)));
      if (book.getWorksheet(sheetDate(reportDate))) throw new Error(`${sheetDate(reportDate)} 시트가 이미 있습니다. 중복 생성하지 않습니다.`);
      const candidate = book.worksheets.filter((s) => /^\d{6}$/.test(s.name) && isoSheetDate(s.name) < reportDate).sort((a, b) => b.name.localeCompare(a.name))[0];
      if (!candidate) throw new Error("기준일보다 앞선 날짜의 전일 일보 시트가 없습니다.");
      const priorDate = isoSheetDate(candidate.name);
      if (priorDate < shiftDate(reportDate, -7)) throw new Error(`전일 일보가 너무 오래되었습니다 (${priorDate}). ${reportDate} 직전 마감 일보가 포함된 파일로 새 작업을 시작하세요.`);
      if (priorDate !== shiftDate(reportDate, -1) && values.carryConfirmation !== "확인") return ask(`${priorDate} 마감 금액을 ${reportDate}의 전일금액으로 이월합니다. 휴무일 동안 거래가 없고 마지막 마감 일보가 맞으면 확인하고 계속하세요.`, [{ key: "carryConfirmation", label: "휴무일 거래 없음 · 마지막 마감 일보 확인", confirm: "확인" }]);
      const filenameDate = files.cashStatus[0].name.normalize("NFC").match(/^(\d{6})_/)?.[1];
      const statusDate = filenameDate ? isoSheetDate(filenameDate) : values.statusDate;
      if (!statusDate) return ask("자금현황표 내부에 기준일이 없습니다. 이 자료의 계좌잔고 마감일(작업일 전날)을 확인하세요.", [{ key: "statusDate", label: "자금현황표 기준일 YYYY-MM-DD" }]);
      // KC 파일명 YYMMDD는 계좌잔고 마감일(일보 기준일)이다. 작업일 15일이면 14일 자금현황표를 쓴다.
      if (date(statusDate) !== reportDate) throw new Error(`자금현황표 기준일 ${statusDate}와 일보 기준일 ${reportDate}가 다릅니다. 작업일 전날(${reportDate}) 자금현황표를 지정하세요.`);
      const kc = readCashStatus(statusBook); const l = layout(candidate);
      const weekly = weeks.map((b, i) => readWeekly(b, files.weeklyPlans[i].name));
      for (const day of [reportDate, workDate]) {
        const selected = weekly.filter((w) => w.dates.has(day));
        if (selected.length > 1) throw new Error(`${day} 주간계획이 여러 파일에 중복됩니다. 사용할 버전 하나만 지정하세요.`);
        if (!selected.length && values.noPlanDates !== `${reportDate},${workDate}`) return ask(`주간계획에 ${day} 날짜가 없습니다. 파일의 내부 날짜를 확인하세요. 휴무일 등으로 해당 날짜 계획이 없다면 확인하고 계속하세요. 잘못된 주 파일이면 새 작업에서 교체하세요.`, [{ key: "noPlanDates", label: `${reportDate}·${workDate} 지주현금 계획 없음`, confirm: `${reportDate},${workDate}` }]);
      }
      let overrides: Record<string, Amount>;
      try {
        // 셀별 숫자 입력란(cell_H9 등)이 기본이고, previousValues JSON은 호환용으로 남긴다.
        overrides = parseOverrides(values.previousValues);
        for (const [key, value] of Object.entries(values)) { const cell = key.match(/^cell_([HI]\d{1,3})$/)?.[1]; if (cell && value.trim()) overrides[cell] = decimal(value, cell); }
      } catch (e) { return ask(`전일 금액 입력을 확인하세요: ${String(e)}`, [{ key: "previousValues", label: "전일 금액 확인 JSON" }]); }
      const previous = priorAmounts(candidate, overrides);
      if (previous.missing.length > MAX_CELL_INPUTS) {
        // 수식 셀 대부분에 값이 없으면 라이브러리(openpyxl 등)로 저장돼 계산 결과가 빠진 파일이다. 셀별 입력보다 Excel 재저장이 답이다.
        return ask(`전일 일보에서 수식의 저장 결과가 없는 셀이 ${previous.missing.length}개입니다 (${previous.missing.slice(0, 12).join(", ")} …). 수식의 계산 결과가 저장되지 않은 파일입니다(Excel이 아닌 프로그램으로 저장한 경우). Excel에서 열어 저장한 원본 파일로 새 작업을 시작하세요. 0으로 추정하지 않습니다.`, [{ key: "previousValues", label: "전일 금액 확인 JSON (예: {\"H9\":\"0\"})", required: false }]);
      }
      if (previous.missing.length) return ask(`전일 일보에서 수식의 저장 결과가 없는 셀이 있습니다. 전일 일보 ${candidate.name} 시트에서 확인한 금액을 셀별로 입력하세요. 0으로 추정하지 않습니다.`, previous.missing.map((cell) => ({ key: `cell_${cell}`, label: `${candidate.name}!${cell} ${cell.startsWith("I") ? "장부금액" : "금일금액"} (${text(candidate.getCell(`C${cell.slice(1)}`)) || "항목 없음"})`, type: "number" as const })));
      let explicit: Record<string, string>;
      try { explicit = values.accountBindings ? z.record(z.string(), z.string().regex(/^[HP]\d{1,3}$/)).parse(JSON.parse(values.accountBindings)) : {}; } catch { return ask('계좌 연결은 {"계좌코드:KRW":"H10"} 형태입니다.', [{ key: "accountBindings", label: "확인한 계좌별 일보 셀 JSON" }]); }
      const { bindings, unresolved } = bindAccounts(candidate, kc.accounts, previous.values, explicit, reportDate);
      if (unresolved.length) return ask(`다음 계좌를 전일 일보와 연결할 수 없습니다. 은행·통화·원금·만기일을 확인해 주세요. 예금 만기가 양쪽 자료에서 다르면 갱신된 전일 일보로 다시 시작해야 합니다.\n${unresolved.join("\n")}\n확실한 연결만 {"계좌코드:통화":"H행번호 또는 P행번호"}로 입력하세요.`, [{ key: "accountBindings", label: "확인한 계좌별 일보 셀 JSON" }]);
      const planActual = weekly.flatMap((w) => w.movements).filter((m) => m.date === reportDate);
      const planNext = weekly.flatMap((w) => w.movements).filter((m) => m.date === workDate);
      const planDeposits = weekly.flatMap((w) => w.deposits).filter((m) => m.date === reportDate);
      const depositField = () => movementField("depositEdits", `${reportDate} 정기예금 집행 (입금: 만기 원금·이자 / 지급: 가입 원금)`, planDeposits);
      if (!values.actualEdits || !values.planEdits || (planDeposits.length && !values.depositEdits)) return ask(`### 집행 내역 확인\n\n자금현황표에는 개별 거래 적요가 없습니다. 아래 표를 확인·수정한 뒤 실행하세요.\n\n- **${reportDate} 실적:** 실제 집행 금액을 입력하세요. 미집행은 **0**으로 바꾸고, 계획에 없던 거래는 추가하세요.\n- **${workDate} 계획:** 예정된 거래와 금액을 확인하세요.\n- **정기예금 집행:** 지주현금 실적과 별도로 확인합니다. 이자는 예금 원금 증감에서 제외합니다.`, [movementField("actualEdits", `${reportDate} 실적`, planActual), movementField("planEdits", `${workDate} 계획`, planNext), ...(planDeposits.length ? [depositField()] : [])]);
      let actual: Movement[], nextPlan: Movement[], deposits: Movement[];
      try {
        actual = applyEdits(planActual, values.actualEdits, reportDate); nextPlan = applyEdits(planNext, values.planEdits, workDate); deposits = applyEdits(planDeposits, values.depositEdits, reportDate);
        if (deposits.some((m) => !depositKind(m))) throw new Error("정기예금 집행은 입금 '정기예금 만기 원금/이자', 지급 '정기예금 가입' 적요만 허용합니다.");
      } catch (e) { return ask(`${String(e)}\n${correctionHelp}`, [movementField("actualEdits", `${reportDate} 실적`, planActual), movementField("planEdits", `${workDate} 계획`, planNext), depositField()]); }
      const termIssues = depositIssues(candidate, previous.values, kc.accounts, bindings, [...actual, ...deposits], reportDate);
      if (termIssues.length) return ask(`### 정기예금 집행 확인\n\n정기예금 원금과 실제 집행 내역이 맞지 않습니다. **이자는 원금에 합산하지 않습니다.**\n\n${bullets(termIssues)}\n\n${correctionHelp}`, [depositField(), movementField("actualEdits", `${reportDate} 실적`, planActual)]);
      const changes: Record<string, { incoming: Amount; outgoing: Amount }> = {};
      try {
        const parsed = values.cashChanges ? z.record(z.string(), z.object({ incoming: numberInput, outgoing: numberInput }).strict()).parse(JSON.parse(values.cashChanges)) : {};
        for (const [key, flow] of Object.entries(parsed)) { if (!bindings.get(key)?.startsWith("H") || !cashRows.includes(Number(bindings.get(key)!.slice(1)))) throw new Error("입출금 보정은 연결된 단기성 계좌만 허용합니다."); const incoming = decimal(flow.incoming, key); const outgoing = decimal(flow.outgoing, key); if (incoming.lt(0) || outgoing.lt(0)) throw new Error("입출금은 0 이상이어야 합니다."); changes[key] = { incoming, outgoing }; }
      } catch (e) { return ask(String(e), [{ key: "cashChanges", label: "확인한 실제 계좌별 입출금 JSON" }]); }
      const flowIssues: string[] = []; const matured = l.activeTerms.filter((row) => maturity(candidate, row) <= reportDate && !previous.values[`H${row}`].isZero()).map((row) => `일보 H${row}: ${previous.values[`H${row}`]} 감소, 만기 ${maturity(candidate, row)}`);
      for (const a of kc.accounts) {
        const target = bindings.get(a.key)!; if (target[0] !== "H") continue;
        const row = Number(target.slice(1)); const opening = previous.values[target]; const flow = changes[a.key] ?? a;
        if (l.activeTerms.includes(row) && maturity(candidate, row) <= reportDate) { if (!a.balance.eq(0)) flowIssues.push(`${a.key}: 만기 도래했지만 계좌잔고가 ${a.balance}입니다. 만기 입금/연장 내역을 확인해 원천을 정정하세요.`); continue; }
        if (!sameWon(opening.plus(flow.incoming).minus(flow.outgoing), a.balance)) flowIssues.push(`${a.key}: 전일일보 ${opening} + 입금 ${flow.incoming} - 지급 ${flow.outgoing} ≠ 계좌잔고 ${a.balance} (장부잔액 ${a.ledger})`);
      }
      if (flowIssues.length) return ask(`장부와 실제 잔고 차이/전일 이월을 확인하세요. 차이를 임의로 지급 처리하지 않습니다. 확인한 실제 입출금 총액을 입력하세요. 예: {"140013557434:KRW":{"incoming":"48200","outgoing":"1000000000"}}\n${flowIssues.join("\n")}`, [{ key: "cashChanges", label: "확인한 실제 계좌별 입출금 JSON" }, { key: "actualEdits", label: "실적 확인/수정" }]);
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
      const audit = { workDate, reportDate, priorSheet: candidate.name, sourceDate: statusDate, rates, bindings: Object.fromEntries(bindings), previousOverrides: values.previousValues ?? null, cashChanges: values.cashChanges ?? null, actual: actual.map((m) => ({ ...m, amount: m.amount.toString() })), plan: nextPlan.map((m) => ({ ...m, amount: m.amount.toString() })), differences: diff, deposits: deposits.map((m) => ({ ...m, amount: m.amount.toString() })), depositDifferences: depositDiff, newDeposits, matured, kcTotal: kc.total.toString(), kcTotalSource: kc.totalSource, sources: Object.fromEntries(Object.entries(files).map(([key, list]) => [key, list.map((f) => ({ name: f.name, fingerprint: f.fingerprint }))])) };
      const review = createHash("sha256").update(JSON.stringify(audit)).digest("hex").slice(0, 12);
      if (values.review !== `확인 ${review}`) return ask([
        `### 최종 확인\n\n**작업일 ${workDate} → 일보 기준일 ${reportDate}**\n\n${candidate.name} 금일금액을 전일금액으로 이월합니다.`,
        "- 원천 수식의 저장된 계산 결과를 사용합니다. 재계산·저장이 완료된 자료인지 확인하세요.\n- 미매핑 빈 계좌 및 기타 채권·적금·신탁에 변동이 없는지 확인하세요.",
        `### 계좌 연결\n\n${bullets(kc.accounts.map((a) => `${a.key} → ${bindings.get(a.key)} (${a.name}, ${a.balance})`))}`,
        `### 계획 대비 실적 차이\n\n${diff.length ? diff.map((d) => `- ${markdownText(d.key.join(" / "))}: 계획 **${d.planned}원** → 실적 **${d.actual}원**`).join("\n") : "차이 없음 (담당자가 실제 집행 확인)"}`,
        `### 정기예금 집행\n\n**이자는 원금 증감에서 제외합니다.**\n\n${deposits.length ? listing(deposits) : "없음"}`,
        `### 신규 가입\n\n${bullets(newDeposits.map((a) => `${a.bank}: ${a.amount} ${a.currency}, ${a.start}~${a.maturity} → ${a.target}`)) || "없음"}`,
        `### 만기\n\n${bullets(matured) || "없음"}`,
        `### 원화 대사 및 환율\n\n- **원화 대사 대상: ${kc.total}원** (${markdownText(kc.totalSource)}, 계좌잔고)\n- 고시: ${rates.date} 최종 ${markdownText(rates.round)}회\n- USD ${rates.perUnit.USD}, JPY(1엔) ${rates.perUnit.JPY}, CNY ${rates.perUnit.CNY}`,
        "확정하려면 **확인하고 계속**을 누르세요. 표를 수정하면 새 확인 코드로 다시 확인합니다.",
      ].join("\n\n"), [{ key: "review", label: `최종 확인 코드 ${review}`, confirm: `확인 ${review}` }, movementField("actualEdits", `${reportDate} 실적`, planActual), movementField("planEdits", `${workDate} 계획`, planNext), ...(planDeposits.length || deposits.length || newDeposits.length ? [depositField()] : [])], checkpoint);
      const built = buildReport(book, candidate, reportDate, workDate, previous.values, kc.accounts, bindings, actual, nextPlan, rates, changes);
      if (!sameWon(built.totalKrw, kc.total)) throw new Error(`총 원화 대사 불일치: 일보 ${built.totalKrw}, KC ${kc.total}, 차이 ${built.totalKrw.minus(kc.total)}. 결과를 발행하지 않습니다.`);
      signal.throwIfAborted(); const image = await renderSheet(built.sheet, built.lastRow); const bytes = new Uint8Array(await book.xlsx.writeBuffer()); signal.throwIfAborted();
      return { status: "completed", summary: `${reportDate} 기준 일보 시트 ${built.sheet.name}를 원본 통합문서에 추가했습니다. 총 원화 ${kc.total.toFixed()}원 대사 일치.`, file: { name: files.previousReport[0].name, bytes }, image: { name: `일일자금일보_${sheetDate(reportDate)}.png`, bytes: image }, checks: [{ name: "전일금액 이월 및 계좌별 증감 대사", passed: true }, { name: "실적 확인 및 주요 집행 마감잔액 대사", passed: true }, { name: "총 원화 = KC 원화 계좌잔고 합계", passed: true }, { name: "정기예금 만기·가입 원금 대사 (이자 제외)", passed: true }, { name: "최종 환율·만기·계좌 연결 확인", passed: true }], externalData: audit };
    } catch (error) { signal.throwIfAborted(); return { status: "failed", message: error instanceof Error ? error.message : String(error) }; }
  },
};
