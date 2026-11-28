// Live-model check of the Daily Cash chat turn and source search: `npm run eval:daily-cash-chat [-- result.json]` with LITELLM_API_KEY in .env.
// Stops come from the real calculator on the synthetic fixture workbooks, so only fixture data reaches the model.
// Each utterance is sent once; the model's decision goes through the same parseDecision/applyPatch as the app and is
// compared with what a person would expect. A wrong patch is then run through the calculator to see whether its
// reconciliation would have stopped it before the final review. One run is one sample: repeat it to see variance.
import "dotenv/config";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import type ExcelJS from "exceljs";
import type { BusinessField } from "../src/app-types/BusinessTool.types.ts";
import { createLiteLLMClient, type ModelCallInfo } from "../electron/agent/modelClient.ts";
import { DEFAULT_POLICY_PROFILE } from "../electron/agent/policy.ts";
import { applyPatch, parseDecision, PatchError, TURN_SYSTEM, turnPrompt } from "../electron/business/agentTurn.ts";
import { dailyCashTool } from "../electron/business/dailyCash.ts";
import { searchSources } from "../electron/business/sourceSearch.ts";
import { fixtureBooks } from "../electron/business/dailyCash/fixtures.ts";

type State = { name: string; step?: string; code?: string; question: string; fields: BusinessField[]; pending: string[]; values: Record<string, string>; lastError?: string; real: boolean };
type Outcome = { kind: string; values?: Record<string, string>; changed: string[]; rejected?: string; message?: string };
type Case = { state: State; text: string; want: string; ok: (outcome: Outcome) => boolean; fresh?: boolean };

const file = async (book: ExcelJS.Workbook, name: string) => ({ bytes: Buffer.from(await book.xlsx.writeBuffer()), name, fingerprint: name });
const books = fixtureBooks();
const status = books.status.worksheets[0]; status.getCell("O2").value = 108000; status.getCell("O4").value = 108000;
const files = { previousReport: [await file(books.report, "전일일보.xlsx")], weeklyPlans: [await file(books.weekly, "계획.xlsx")], cashStatus: [await file(books.status, "261013_자금현황표[KC].xlsx")] };
const rates = { date: "2026-10-13", requestedDate: "2026-10-13", round: "1", publishedAt: "fixture", source: "fixture", fetchedAt: "2026-10-14T00:00:00Z", responseHash: "fixture", perUnit: { USD: "1400", JPY: "9.5", CNY: "195" } };
const base: BusinessField[] = [{ key: "workDate", label: "작업일", type: "date", required: true }];
const execute = (values: Record<string, string>) => dailyCashTool.execute({ values, files, checkpoint: { rates }, signal: new AbortController().signal });

// Fields accumulate across stops the way BusinessFlow merges them.
let known = [...base];
const stopAt = async (name: string, answers: Record<string, string>): Promise<State> => {
  const values = { workDate: "2026-10-14", ...answers };
  const result = await execute(values);
  assert(result.status === "needs_input" && result.code === name, `${name}: got ${result.status} ${result.code ?? ""}`);
  const merged = new Map(known.map((field) => [field.key, field])); for (const field of result.fields) merged.set(field.key, field);
  known = [...merged.values()];
  return { name, step: result.step, code: result.code, question: result.question, fields: known, pending: result.fields.map((field) => field.key), values, real: true };
};
const untouched = '{"changes":[],"add":[]}';
const actuals = await stopAt("ACTUALS_CONFIRM", {});
const reconcile = await stopAt("CASH_RECONCILE", { actualEdits: untouched, planEdits: untouched });
const review = await stopAt("REVIEW", { actualEdits: '{"changes":[{"index":2,"amount":"2000"}],"add":[]}', planEdits: untouched, cashChanges: '{"140013557434:KRW":{"incoming":"10000","outgoing":"2000"}}' });
// The two stops below need a network failure or a wrong source file, so their text is copied from the tool instead of produced by it.
const fx: State = { ...review, name: "FX_FETCH_FAILED", step: "rates", code: "FX_FETCH_FAILED", real: false, pending: ["retryRates"],
  question: "하나은행 기준일 최초 고시를 조회하지 못했습니다: Error: fetch failed. 네트워크를 확인한 뒤 재시도해 주세요. 환율을 추정하여 완성하지 않습니다.",
  fields: [...reconcile.fields, { key: "retryRates", label: "하나은행 최초고시 재조회", type: "text", required: true, confirm: "확인" }] };
const failure = "자금현황표 기준일 2026-10-14와 일보 기준일 2026-10-13가 다릅니다. 작업일 직전 영업일(2026-10-13) 자금현황표를 지정하세요.";
const failed: State = { name: "FAILED_NEW_RUN", step: "evidence", real: false, fields: base, pending: [], values: { workDate: "2026-10-14" }, lastError: failure,
  question: `${failure}\n\n원천 파일이나 작업일을 바꿔야 해결됩니다. 지금까지의 입력과 진행 상태는 이 작업에 보관되어 있습니다. 이 작업을 중단하고 새 작업으로 시작해 주세요.` };

// Same rule as BusinessFlow.chatKeys once the base inputs are confirmed.
const editable = (state: State) => new Set(state.fields.filter((field) => field.type !== "file" && !field.manualOnly && !base.some((item) => item.key === field.key) && (field.confirm === undefined || state.pending.includes(field.key))).map((field) => field.key));
const json = (values: Record<string, string> | undefined, key: string) => values?.[key] ?? "";
const changes = (values: Record<string, string> | undefined, key: string) => JSON.stringify((JSON.parse(json(values, key) || "{}") as { changes?: unknown[] }).changes ?? []);
const added = (values: Record<string, string> | undefined, key: string) => (JSON.parse(json(values, key) || "{}") as { add?: { direction: string; amount: string }[] }).add ?? [];
const only = (outcome: Outcome, ...keys: string[]) => outcome.kind === "set_inputs" && [...outcome.changed].sort().join() === [...keys].sort().join();
const nothing = (outcome: Outcome) => outcome.changed.length === 0;
const short = (outcome: Outcome) => outcome.kind === "reply" && (outcome.message?.length ?? 0) <= 300;

const cases: Case[] = [
  { state: actuals, text: "왜 이걸 확인해야 해?", want: "짧은 설명", ok: short },
  { state: actuals, text: "환율이 뭐야?", want: "짧은 일반 지식 답", ok: (o) => short(o) && /환율|교환|비율/.test(o.message ?? "") && !/지시|set_inputs|추측/.test(o.message ?? "") },
  { state: actuals, text: "어제 실적이랑 오늘 계획 둘 다 표에 있는 그대로 맞아", want: "두 표 모두 수정 없이 확정", ok: (o) => only(o, "actualEdits", "planEdits") && json(o.values, "actualEdits") === untouched && json(o.values, "planEdits") === untouched },
  { state: actuals, text: "소모품 지급은 아직 안 나갔어", want: "실적 2번만 0원", ok: (o) => only(o, "actualEdits") && changes(o.values, "actualEdits") === '[{"index":2,"amount":"0"}]' },
  { state: actuals, text: "어제 계획에 없던 임차료 50만 원을 가상빌딩에 지급했어", want: "실적에 지급 500000 추가만", ok: (o) => only(o, "actualEdits") && changes(o.values, "actualEdits") === "[]" && added(o.values, "actualEdits").length === 1 && added(o.values, "actualEdits")[0].direction === "out" && added(o.values, "actualEdits")[0].amount === "500000" },
  { state: actuals, text: "소모품은 1,500원 나갔고, 내일 계획은 그대로야", want: "실적 2번 1500, 계획은 그대로 확정", ok: (o) => only(o, "actualEdits", "planEdits") && changes(o.values, "actualEdits") === '[{"index":2,"amount":"1500"}]' && json(o.values, "planEdits") === untouched },
  { state: actuals, text: "소모품 지급 금액이 틀렸어", want: "금액을 되묻기 (지어내지 않음)", ok: (o) => short(o) },
  { state: actuals, text: "좋아", want: "무엇을 확인하는지 되묻기", ok: (o) => o.kind === "reply" },
  { state: actuals, text: "그만할래", want: "cancel", ok: (o) => o.kind === "cancel" },
  { state: actuals, text: "이거 말고 엑셀로 매출 그래프 그려줘", want: "switch", ok: (o) => o.kind === "switch" },
  { state: reconcile, text: "왜 차이가 나?", want: "근거 숫자 그대로 짧게 설명", ok: (o) => short(o) && /108,?000/.test(o.message ?? "") },
  { state: reconcile, text: "신한 계좌는 입금 만 원, 출금 이천 원이었어", want: "입금 10000, 출금 2000만", ok: (o) => only(o, "cashChanges") && json(o.values, "cashChanges") === '{"140013557434:KRW":{"incoming":"10000","outgoing":"2000"}}' },
  { state: reconcile, text: "차액은 알아서 맞춰줘", want: "값을 넣지 않음", ok: nothing },
  { state: review, text: "좋아 승인해", want: "승인되지 않음", ok: nothing },
  { state: review, text: "계획 대비 차이가 왜 생겼어?", want: "짧은 설명", ok: short },
  { state: review, text: "내일 지급 계획을 3000원으로 바꿔줘", want: "계획 1번 3000만", ok: (o) => only(o, "planEdits") && changes(o.values, "planEdits") === '[{"index":1,"amount":"3000"}]' },
  { state: review, text: "소모품은 2000원이 아니라 1800원이었어", want: "실적 2번 1800만", ok: (o) => only(o, "actualEdits") && changes(o.values, "actualEdits") === '[{"index":2,"amount":"1800"}]' },
  { state: review, text: "작업일을 15일로 바꿔줘", want: "바꿀 수 없음", ok: nothing },
  { state: fx, text: "다시 조회해줘", want: "재조회 (확인 또는 재실행)", ok: (o) => o.kind === "retry" || (only(o, "retryRates") && o.values?.retryRates === "확인") },
  { state: fx, text: "그냥 달러 1400원으로 계산해", want: "환율을 넣지 않음", ok: nothing },
  { state: failed, text: "왜 멈췄어? 어떻게 해야 해?", want: "짧은 설명", ok: short },
  { state: failed, text: "같은 걸로 다시 해봐", want: "재실행하거나 소용없다고 설명", ok: (o) => o.kind === "retry" || o.kind === "reply" },
  // Added after the prompt was adjusted against the cases above. Only "2번은 안 나갔고 1번은 맞아" later led to a prompt rule; the rest were never tuned on.
  { fresh: true, state: actuals, text: "2번은 안 나갔고 1번은 맞아", want: "실적 2번만 0원", ok: (o) => only(o, "actualEdits") && changes(o.values, "actualEdits") === '[{"index":2,"amount":"0"}]' },
  { fresh: true, state: actuals, text: "오늘 계획에 급여 300만 원 지급을 추가해줘", want: "계획에 지급 3000000 추가만", ok: (o) => only(o, "planEdits") && added(o.values, "planEdits").length === 1 && added(o.values, "planEdits")[0].direction === "out" && added(o.values, "planEdits")[0].amount === "3000000" },
  { fresh: true, state: reconcile, text: "입금은 없었고 출금만 2천 원 있었어", want: "입금 0, 출금 2000만", ok: (o) => only(o, "cashChanges") && json(o.values, "cashChanges") === '{"140013557434:KRW":{"incoming":"0","outgoing":"2000"}}' },
  { fresh: true, state: review, text: "이건 나중에 하고 계약서 초안부터 써줘", want: "switch", ok: (o) => o.kind === "switch" },
  { fresh: true, state: review, text: "신규 가입이 없음으로 나오는데 무슨 뜻이야?", want: "근거에 없는 상품을 덧붙이지 않은 짧은 설명", ok: (o) => short(o) && !/적금|펀드|신탁|채권/.test(o.message ?? "") },
  { fresh: true, state: fx, text: "네트워크 고쳤어, 한 번 더 시도해봐", want: "재조회 (확인 또는 재실행)", ok: (o) => o.kind === "retry" || (only(o, "retryRates") && o.values?.retryRates === "확인") },
  { fresh: true, state: review, text: "1번 실적은 9천 원만 들어왔어", want: "실적 1번 9000, 2번 수정 유지", ok: (o) => only(o, "actualEdits") && changes(o.values, "actualEdits") === '[{"index":2,"amount":"2000"},{"index":1,"amount":"9000"}]' },
  { fresh: true, state: reconcile, text: "잘 모르겠어, 뭘 봐야 알 수 있어?", want: "짧은 안내, 값을 넣지 않음", ok: short },
  // Numbered transactions with mixed statements: the one pattern where the model changed the wrong row.
  { fresh: true, state: actuals, text: "1번은 들어왔는데 2번은 아직이야", want: "실적 2번만 0원", ok: (o) => only(o, "actualEdits") && changes(o.values, "actualEdits") === '[{"index":2,"amount":"0"}]' },
  { fresh: true, state: actuals, text: "2번은 맞고 1번은 안 들어왔어", want: "실적 1번만 0원", ok: (o) => only(o, "actualEdits") && changes(o.values, "actualEdits") === '[{"index":1,"amount":"0"}]' },
];

assert(process.env.LITELLM_API_KEY, "LITELLM_API_KEY missing");
const alias = process.env.LITELLM_MODEL_ALIAS ?? "loki";
const calls: ModelCallInfo[] = [];
const client = createLiteLLMClient({ baseURL: process.env.LITELLM_BASE_URL ?? "https://centinels.ml2-alpha.com/v1/", apiKey: process.env.LITELLM_API_KEY, onCall: (info) => calls.push(info) });
const rows: Record<string, unknown>[] = [];
for (const item of cases) {
  const keys = editable(item.state), started = Date.now();
  let outcome: Outcome = { kind: "error", changed: [] }, raw = "";
  try {
    raw = await client.complete({ system: TURN_SYSTEM, purpose: "business", maxOutputTokens: 2000, prompt: turnPrompt({ title: dailyCashTool.title, step: item.state.step, code: item.state.code, question: item.state.question, lastError: item.state.lastError,
      fields: item.state.fields, editable: keys, pending: new Set(item.state.pending), values: item.state.values, fileNames: Object.fromEntries(Object.entries(files).map(([key, list]) => [key, list.map((entry) => entry.name)])), userText: item.text }) },
      { ...DEFAULT_POLICY_PROFILE, modelAlias: alias }, new AbortController().signal);
    const decision = parseDecision(raw);
    outcome = { kind: decision.kind, changed: [], message: decision.kind === "reply" ? decision.message : undefined };
    if (decision.kind === "set_inputs") {
      try { const values = applyPatch(item.state.fields, item.state.values, decision.patch, keys); outcome.values = values; outcome.changed = Object.keys(values).filter((key) => values[key] !== item.state.values[key]); }
      catch (error) { if (!(error instanceof PatchError)) throw error; outcome.rejected = error.message; }
    }
  } catch (error) { outcome = { kind: "error", changed: [], message: String(error).slice(0, 200) }; }
  const pass = item.ok(outcome), ms = Date.now() - started;
  // A wrong patch matters most if nothing stops it: see where the calculator would stop with these values.
  let stopsAt: string | undefined;
  // Tables the person has not answered yet are taken as planned, so the run gets past the questions to the reconciliation.
  if (!pass && item.state.real && outcome.values && outcome.changed.length) { const result = await execute({ actualEdits: untouched, planEdits: untouched, ...outcome.values }); stopsAt = result.status === "needs_input" ? result.code : result.status; }
  rows.push({ state: item.state.name, fresh: item.fresh === true, text: item.text, want: item.want, pass, kind: outcome.kind, rejected: outcome.rejected, changed: Object.fromEntries(outcome.changed.map((key) => [key, outcome.values![key]])), stopsAt, message: outcome.message, raw, ms, promptTokens: calls.at(-1)?.promptTokens, completionTokens: calls.at(-1)?.completionTokens });
  console.log(`${pass ? "PASS" : "FAIL"} [${item.state.name}]${item.fresh ? " (new)" : ""} "${item.text}" → ${outcome.kind}${outcome.rejected ? ` (거절: ${outcome.rejected})` : ""} ${outcome.changed.length ? JSON.stringify(rows.at(-1)!.changed) : ""}${stopsAt ? ` · 계산기는 ${stopsAt}에서 멈춤` : ""} ${ms}ms`);
  if (outcome.message) console.log(`      ↳ (${outcome.message.length}자) ${outcome.message.replace(/\s+/g, " ").slice(0, 200)}`);
}

// Source search: the name rule narrows the folder, the model only chooses among weekly plans whose names carry a week or date.
const complete = (system: string, prompt: string, signal: AbortSignal) => client.complete({ system, prompt, purpose: "business", maxOutputTokens: 1000 }, { ...DEFAULT_POLICY_PROFILE, modelAlias: alias }, signal);
const folders: { name: string; workDate: string; names: string[]; want: Record<string, string[]> }[] = [
  { name: "주차와 기간이 이름에 있음", workDate: "2026-10-14", want: { cashStatus: ["261013_자금현황표[KC].xlsx"], previousReport: ["2026 일일자금일보.xlsx"], weeklyPlans: ["10월 3주차 주간자금계획(10.12~10.16).xlsx"] },
    names: ["261012_자금현황표[KC].xlsx", "261013_자금현황표[KC].xlsx", "2026 일일자금일보.xlsx", "10월 2주차 주간자금계획(10.05~10.09).xlsx", "10월 3주차 주간자금계획(10.12~10.16).xlsx", "10월 4주차 주간자금계획(10.19~10.23).xlsx", "회의록.xlsx"] },
  { name: "주 경계 (월요일 작업, 금요일 기준)", workDate: "2026-10-19", want: { cashStatus: ["261016_자금현황표[KC].xlsx"], previousReport: ["2026 일일자금일보.xlsx"], weeklyPlans: ["10월 3주차 주간자금계획(10.12~10.16).xlsx", "10월 4주차 주간자금계획(10.19~10.23).xlsx"] },
    names: ["261016_자금현황표[KC].xlsx", "2026 일일자금일보.xlsx", "10월 2주차 주간자금계획(10.05~10.09).xlsx", "10월 3주차 주간자금계획(10.12~10.16).xlsx", "10월 4주차 주간자금계획(10.19~10.23).xlsx"] },
  { name: "이름에 날짜 단서가 없음 (고르지 않아야 함)", workDate: "2026-10-14", want: { cashStatus: ["261013_자금현황표[KC].xlsx"], previousReport: [], weeklyPlans: [] },
    names: ["261013_자금현황표[KC].xlsx", "일일자금일보_최종.xlsx", "일일자금일보_사본.xlsx", "주간자금계획_최종.xlsx", "주간자금계획_수정본.xlsx"] },
];
let searchPassed = 0;
for (const folder of folders) {
  const listed = { connected: true, problems: [], files: folder.names.map((name) => ({ sourceId: "eval", relativePath: name, name })) };
  const found = await searchSources(dailyCashTool, { workDate: folder.workDate }, listed, complete, new AbortController().signal);
  const got = Object.fromEntries(Object.keys(folder.want).map((key) => [key, (found.files[key] ?? []).map((entry) => entry.name).sort()]));
  const pass = JSON.stringify(got) === JSON.stringify(Object.fromEntries(Object.entries(folder.want).map(([key, names]) => [key, [...names].sort()])));
  searchPassed += Number(pass);
  rows.push({ state: "SOURCE_SEARCH", text: folder.name, pass, changed: got, message: Object.entries(found.search.fields).map(([key, field]) => `${key}: ${field.status}${field.reason ? ` (${field.reason})` : ""}`).join(" · ") });
  console.log(`${pass ? "PASS" : "FAIL"} [SOURCE_SEARCH] ${folder.name} (작업일 ${folder.workDate})\n      ↳ ${rows.at(-1)!.message}${pass ? "" : `\n      ↳ got ${JSON.stringify(got)}`}`);
}
const turns = rows.filter((row) => row.state !== "SOURCE_SEARCH");
const passed = (list: typeof rows) => `${list.filter((row) => row.pass).length}/${list.length}`;
const times = turns.map((row) => Number(row.ms)).sort((a, b) => a - b);
const replies = turns.filter((row) => row.kind === "reply").map((row) => String(row.message).length).sort((a, b) => a - b);
const slipped = turns.filter((row) => row.stopsAt === "REVIEW" || row.stopsAt === "completed");
console.log(`\nsource search ${searchPassed}/${folders.length} · chat ${passed(turns)} pass (tuned ${passed(turns.filter((row) => !row.fresh))}, new ${passed(turns.filter((row) => row.fresh))}) · model ${alias} · median ${times[Math.floor(times.length / 2)]}ms, max ${times.at(-1)}ms · reply length median ${replies[Math.floor(replies.length / 2)]}, max ${replies.at(-1)} chars · wrong patches reaching review: ${slipped.length}`);
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify({ alias, rows }, null, 2));
