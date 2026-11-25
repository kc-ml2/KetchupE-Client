// Plot baseline: runs the plotkit study requests through KetchupE's own Excel tool and scores what it drew.
// KetchupE makes every model call (createLiteLLMClient, as the runtime does); nothing from plotkit-ts is used.
//
// Bundle and run with Electron (see scripts/plot-eval/README.md):
//   --tga <tga_plot checkout>  --cnt <dir holding experiments/eval/cnt>  --out <dir>  --worker dist-electron/excel.worker.js
//   [--only 02,D015] [--sets tga,cnt,ketchupe] [--fixture] [--replay responses.json]
// Live mode needs LITELLM_API_KEY (and optionally LITELLM_BASE_URL, LITELLM_MODEL_ALIAS). --fixture runs the TGA
// cases with a fixed chart plan and no model, to check the harness itself. --replay {"<case id>": [response, ...]}
// answers each model call of a case with the next recorded response (no model), to check the grader or re-score.
import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { app } from "electron";
import ExcelJS from "exceljs";
import sharp from "sharp";
import "dotenv/config";
import { createLiteLLMClient, resolveModelAlias, type ModelCallInfo } from "../../electron/agent/modelClient.ts";
import { DEFAULT_POLICY_PROFILE } from "../../electron/agent/policy.ts";
import { createExcelTool, type ExcelJobs } from "../../electron/excel/tool.ts";
import { createExcelWorker } from "../../electron/excel/workerClient.ts";
import { captureChartPng, printReportPdf } from "../../electron/excel/pdf.ts";
import { EXCEL_LIMITS } from "../../electron/excel/limits.ts";
import type { AnalysisPlan, ChartRequest, Report } from "../../electron/excel/contracts.ts";
import type { ToolResult } from "../../electron/business/contracts.ts";
import { checkCnt, checkTga, type CheckResult } from "./check.ts";

type Turn = { text: string; format?: string; answer?: string; score: (report: Report, png?: { width: number; height: number }) => CheckResult[] };
type Case = { id: string; set: "tga" | "cnt" | "ketchupe"; files: string[]; turns: Turn[] };
type Call = { purpose: "planner" | "revision"; latencyMs: number; promptTokens: number; completionTokens: number; finishReason?: string; error?: string; kind?: string; askReason?: string };

const AUTO_ANSWER = "요청한 내용대로 진행해 주세요. 정해지지 않은 부분은 일반적인 기본값으로 해 주세요.";
const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };

async function tgaCases(root: string): Promise<Case[]> {
  const prompts = await readFile(join(root, "tests/AGENT_TEST_PROMPTS.md"), "utf8");
  const expected = JSON.parse(await readFile(join(root, "tests/expected_requests.json"), "utf8"));
  const cases: Case[] = [];
  for (const [, id, body] of prompts.matchAll(/^## (\d+)_\S+\n+```text\n([\s\S]*?)```/gm)) {
    const lines = body.trim().split("\n");
    const file = lines.find(l => l.startsWith("파일:"))!.replace("파일:", "").trim();
    const format = lines.find(l => l.startsWith("결과 형식:"))?.replace("결과 형식:", "").trim();
    const text = lines.filter(l => !l.startsWith("파일:") && !l.startsWith("결과 형식:")).join("\n").trim();
    const checks: Record<string, unknown>[] = expected[id]?.checks ?? [];
    cases.push({ id, set: "tga", files: [join(root, file)], turns: [{ text, format, answer: "시트마다 각각 따로 그려줘. 나머지는 알아서 기본값으로 해줘.", score: (report, png) => checks.map(c => checkTga(c, report, png)) }] });
  }
  return cases;
}

const AGG: Record<string, string> = { mean: "평균", sum: "합계", count: "건수", median: "중앙값", max: "최댓값", min: "최솟값" };
/** What the engineer in the CNT study would answer when asked: the sheet(s) and the aggregation of the expected plot. */
function cntAnswer(expect: any) {
  const data = expect?.data ?? {}, parts: string[] = [];
  if (data.sheet) parts.push(`시트는 ${data.sheet === "*" ? "전부 한 그림에" : [data.sheet].flat().join(", ")}`);
  if (data.agg) parts.push(`집계는 ${AGG[data.agg] ?? data.agg}`);
  if (data.by && data.by !== "_series") parts.push(`${data.by}별로 나눠서`);
  return `${parts.length ? parts.join(", ") + "로 해줘." : ""} 나머지는 알아서 기본값으로 해줘.`.trim();
}

async function cntCases(root: string): Promise<Case[]> {
  const base = join(root, "experiments/eval/cnt");
  const { items } = JSON.parse(await readFile(join(base, "dev/requests.json"), "utf8"));
  return items.map((item: any) => ({
    id: item.id, set: "cnt", files: item.files.map((f: string) => join(base, f)),
    turns: item.turns.map((turn: any) => ({ text: turn.text, answer: cntAnswer(turn.expect), score: (report: Report) => checkCnt(turn.expect, report) })),
  }));
}

/** KetchupE's own revision session (scripts/excel-revision-smoke.ts), scored on the drawn view. */
function ketchupeCases(tgaRoot: string): Case[] {
  const view = (r: Report) => r.view?.charts["0"] ?? {};
  const c = (check: string, pass: boolean, detail?: unknown): CheckResult => ({ check, pass, detail: detail === undefined ? undefined : JSON.stringify(detail) });
  return [{
    id: "K01", set: "ketchupe", files: [join(tgaRoot, "tests/inputs/TGA.xlsx")], turns: [
      { text: "1006R1-V normal 시트의 원본 Weight (%) TGA 그래프를 HTML로 만들어줘. Temperature가 x축, Weight는 왼쪽 축, Deriv. Weight는 오른쪽 축.", score: r => [c("chart", (r.result.charts ?? []).length + (r.result.chart ? 1 : 0) > 0)] },
      { text: "weight, temperature, Deriv.Weight 축 scale값들은 소수점 없이 맞춰주고, Deriv.Weight의 max peak를 그래프에 표시해줘.", score: r => [
        c("decimals", (["x", "left", "right"] as const).every(s => view(r).axes?.[s]?.decimals === 0), view(r).axes),
        c("peak", (view(r).annotations ?? []).some(a => a.kind === "max"), view(r).annotations)] },
      { text: "왼쪽 Y축은 0~100 간격 20, 오른쪽 Y축은 0.0~1.2 간격 0.2 소수 한 자리. X축 눈금은 0,200,400,600,800으로 맞춰줘. 데이터는 전부 유지해줘.", score: r => [
        c("left", view(r).axes?.left?.min === 0 && view(r).axes?.left?.max === 100 && view(r).axes?.left?.tickStep === 20, view(r).axes?.left),
        c("right", view(r).axes?.right?.max === 1.2 && view(r).axes?.right?.tickStep === 0.2 && view(r).axes?.right?.decimals === 1, view(r).axes?.right),
        c("x ticks", JSON.stringify(view(r).axes?.x?.tickValues) === "[0,200,400,600,800]", view(r).axes?.x),
        c("kept peak", (view(r).annotations ?? []).some(a => a.kind === "max"))] },
      { text: "앞선 축 설정은 그대로 두고 D열 Deriv. Weight 최대값이 나오는 Temperature를 Tmax로 표시해줘.", score: r => [
        c("Tmax", (view(r).annotations ?? []).some(a => a.kind === "max" && a.label === "Tmax"), view(r).annotations),
        c("kept axes", view(r).axes?.left?.tickStep === 20 && view(r).axes?.right?.decimals === 1)] },
      { text: "제목을 TGA 열분해 분석으로 바꾸고 HTML, PDF, PNG, PPTX로 저장해줘.", score: r => [
        c("title", view(r).title === "TGA 열분해 분석", view(r).title),
        c("formats", ["html", "pdf", "png", "pptx"].every(f => (r.plan.formats ?? [r.plan.format]).includes(f as never)), r.plan.formats),
        c("kept Tmax", (view(r).annotations ?? []).some(a => a.label === "Tmax"))] },
    ],
  }];
}

/** Fixture planner: the TGA chart plan of excel-revision-smoke, for any TGA.xlsx request. */
async function fixturePlan(file: string): Promise<ChartRequest> {
  const book = new ExcelJS.Workbook(); await book.xlsx.load(await readFile(file) as never);
  const sheet = book.worksheets[0];
  const unit = (index: number) => String(sheet.getCell(1, index).value).match(/[（(]([^()（）]+)[）)]\s*$/)?.[1] ?? "";
  return {
    kind: "chart", title: "TGA", format: "html", steps: ["전체 측정값"], assumptions: ["원본 값"],
    input: { fileId: "file1", sheet: sheet.name, headerRow: 1, firstDataRow: 2, lastDataRow: sheet.rowCount, columns: [2, 3, 4].map((index, i) => ({ index, name: String(sheet.getCell(1, index).value), key: ["x", "w", "d"][i] })) },
    x: { key: "x", label: "Temperature", unit: unit(2) }, series: [{ key: "w", label: "Weight", unit: unit(3), axis: "left" }, { key: "d", label: "Deriv. Weight", unit: unit(4), axis: "right" }],
  } as ChartRequest;
}

app.on("window-all-closed", () => undefined);
async function main() {
  const tgaRoot = resolve(arg("tga") ?? "../tga_plot"), cntRoot = arg("cnt"), out = resolve(arg("out") ?? "outputs/plot-eval"), workerPath = resolve(arg("worker") ?? "dist-electron/excel.worker.js");
  const replay: Record<string, unknown[]> | undefined = arg("replay") ? JSON.parse(await readFile(resolve(arg("replay")!), "utf8")) : undefined;
  const fixture = process.argv.includes("--fixture") || Boolean(replay), only = arg("only")?.split(","), sets = (arg("sets") ?? (fixture && !replay ? "tga" : "tga,cnt,ketchupe")).split(",");
  await app.whenReady();
  await mkdir(out, { recursive: true });
  const cases = [
    ...(sets.includes("tga") ? await tgaCases(tgaRoot) : []),
    ...(sets.includes("cnt") && cntRoot ? await cntCases(resolve(cntRoot)) : []),
    ...(sets.includes("ketchupe") ? ketchupeCases(tgaRoot) : []),
  ].filter(c => !only || only.includes(c.id));
  assert(cases.length, "no cases selected");

  const baseURL = process.env.LITELLM_BASE_URL ?? "https://centinels.ml2-alpha.com/v1/";
  if (!fixture) assert(process.env.LITELLM_API_KEY, "LITELLM_API_KEY missing (or pass --fixture)");
  const modelAlias = fixture ? "fixture" : await resolveModelAlias(baseURL, process.env.LITELLM_API_KEY!, process.env.LITELLM_MODEL_ALIAS ?? "loki");
  const client = fixture ? undefined : createLiteLLMClient({ baseURL, apiKey: process.env.LITELLM_API_KEY! });
  const worker = createExcelWorker(workerPath);
  const resultsFile = join(out, "results.jsonl");
  await writeFile(resultsFile, "");
  try {
    for (const item of cases) {
      const record: Record<string, unknown> = { id: item.id, set: item.set, modelAlias, turns: [] as unknown[] };
      if (item.files.some(f => !/\.xlsx$/i.test(f))) {
        record.status = "input_unsupported";
        record.detail = `케찹이 입력은 .xlsx만: ${item.files.map(f => basename(f)).join(", ")}`;
        await appendFile(resultsFile, JSON.stringify(record) + "\n");
        console.log(item.id, "input_unsupported");
        continue;
      }
      const calls: Call[] = [];
      const captured: { last?: { plan: AnalysisPlan; analysis: Awaited<ReturnType<ExcelJobs["analyze"]>> } } = {};
      const jobs: ExcelJobs = {
        profile: (bytes, signal, query, inspection) => worker.run({ kind: "profile", bytes, query, inspection }, signal),
        analyze: async (files, plan, signal) => { const analysis = await worker.run({ kind: "analyze", files, plan }, signal); captured.last = { plan, analysis }; return analysis; },
        export: (report, format, signal) => worker.run({ kind: "export", report, format }, signal),
      };
      const call = (purpose: Call["purpose"], maxOutputTokens: number) => async (system: string, prompt: string, signal: AbortSignal) => {
        const started = Date.now();
        try {
          const recorded = replay?.[item.id]?.shift();
          const response = client ? await client.complete({ system, prompt, purpose: "excel", maxOutputTokens }, { ...DEFAULT_POLICY_PROFILE, modelAlias }, signal)
            : replay ? (typeof recorded === "string" ? recorded : JSON.stringify(recorded ?? { kind: "unsupported", message: "replay exhausted" }))
            : purpose === "planner" ? JSON.stringify(await fixturePlan(item.files[0])) : JSON.stringify({ kind: "view", patch: { charts: { "0": { title: "fixture" } } } });
          const info: ModelCallInfo | undefined = client?.lastCallFor?.(signal) ?? client?.lastCall;
          let parsed: { kind?: string; reason?: string } = {};
          try { parsed = JSON.parse(response.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); } catch { /* malformed replies are counted by the tool's repair loop */ }
          calls.push({ purpose, latencyMs: Date.now() - started, promptTokens: info?.promptTokens ?? 0, completionTokens: info?.completionTokens ?? 0, finishReason: info?.finishReason, kind: parsed.kind, ...(parsed.kind === "ask" ? { askReason: parsed.reason } : {}) });
          return response;
        } catch (error) {
          calls.push({ purpose, latencyMs: Date.now() - started, promptTokens: 0, completionTokens: 0, error: String(error) });
          throw error;
        }
      };
      const tool = createExcelTool({ ...jobs, pdf: printReportPdf, png: captureChartPng, complete: call("planner", EXCEL_LIMITS.outputTokens), revise: call("revision", 2000) });
      const files = await Promise.all(item.files.map(async f => { const bytes = await readFile(f); return { bytes, name: basename(f), fingerprint: createHash("sha256").update(bytes).digest("hex") }; }));
      let values: Record<string, string> = { request: item.turns[0].text, ...(item.turns[0].format ? { format: item.turns[0].format } : {}) };
      let checkpoint: Record<string, unknown> = {}, result: ToolResult | undefined;
      for (const [index, turn] of item.turns.entries()) {
        const started = Date.now(), firstCall = calls.length;
        const signal = AbortSignal.timeout(EXCEL_LIMITS.submissionMs);
        const base = { files: { source: files }, signal, onTrace: () => undefined };
        if (index > 0) values = { ...values, revision: turn.text };
        captured.last = undefined;
        let autoAnswers = 0;
        try {
          result = await tool.execute({ ...base, values, checkpoint, ...(index > 0 ? { userText: turn.text } : {}) });
          // A clarifying question gets the answer a user would give (the expected sheet/aggregation), at most twice.
          while (result.status === "needs_input" && autoAnswers < 2) {
            autoAnswers++;
            const key = result.fields[0]?.key ?? "revisionAnswer", answer = turn.answer ?? AUTO_ANSWER;
            values = { ...values, [key]: answer };
            result = await tool.execute({ ...base, values, checkpoint: result.checkpoint ?? checkpoint, userText: answer, changedKeys: [key] });
          }
        } catch (error) { result = { status: "failed", message: String(error) }; }
        if (result.status !== "failed" && result.checkpoint) checkpoint = result.checkpoint;
        const turnCalls = calls.slice(firstCall);
        const turnRecord: Record<string, unknown> = {
          turn: index, text: turn.text, status: result.status, ms: Date.now() - started, autoAnswers,
          modelCalls: turnCalls.length, askReasons: turnCalls.filter(c => c.kind === "ask").map(c => c.askReason ?? "?"), promptTokens: turnCalls.reduce((n, c) => n + c.promptTokens, 0), completionTokens: turnCalls.reduce((n, c) => n + c.completionTokens, 0), calls: turnCalls,
          ...(result.status === "needs_input" ? { question: result.question } : result.status === "failed" ? { message: result.message } : {}),
        };
        const last = (captured as typeof captured).last; // set inside jobs.analyze, after the reset above
        if (result.status === "completed" && last) {
          const external = (result.externalData ?? {}) as { view?: Report["view"]; formats?: AnalysisPlan["formats"] };
          const report = { ...last.analysis, plan: { ...last.plan, formats: external.formats ?? last.plan.formats }, view: external.view, sources: files.map((f, i) => ({ id: `file${i + 1}`, name: f.name, fingerprint: f.fingerprint })), summary: result.summary, createdAt: new Date().toISOString() } as Report;
          const pngFile = [result.file, ...(result.additionalFiles ?? [])].find(f => f.name.endsWith(".png"));
          const meta = pngFile ? await sharp(pngFile.bytes).metadata() : undefined;
          let checks: CheckResult[];
          try { checks = turn.score(report, meta?.width ? { width: meta.width, height: meta.height! } : undefined); }
          catch (error) { checks = [{ check: "score", pass: false, detail: `채점 오류: ${String(error)}` }]; }
          turnRecord.checks = checks;
          turnRecord.pass = checks.filter(c => c.pass !== null).every(c => c.pass);
          turnRecord.chartTypes = (report.result.charts ?? (report.result.chart ? [report.result.chart] : [])).map(c => c.type);
          turnRecord.planKind = /^const p = /m.test(report.plan.code) ? "chart" : "execute";
        } else turnRecord.pass = false;
        (record.turns as unknown[]).push(turnRecord);
        console.log(item.id, `turn ${index}`, result.status, turnRecord.pass ? "PASS" : "FAIL", `${turnRecord.ms}ms`, `${turnRecord.promptTokens}+${turnRecord.completionTokens} tok`);
        if (result.status !== "completed") break;
      }
      record.status = (record.turns as { status: string }[]).every(t => t.status === "completed") && (record.turns as unknown[]).length === item.turns.length ? "completed" : "incomplete";
      record.pass = (record.turns as { pass: boolean }[]).length === item.turns.length && (record.turns as { pass: boolean }[]).every(t => t.pass);
      await appendFile(resultsFile, JSON.stringify(record) + "\n");
    }
  } finally { worker.close(); }
  console.log(`results: ${resultsFile}`);
}
void main().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
