// @vitest-environment node
import { expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import { JSDOM } from "jsdom";
import { analysisResult, validateResult, type ChartRequest, type InputRow } from "./contracts.ts";
import { compileChart, preflight } from "./chartPlan.ts";
import { compressSources, sourceFor } from "./sources.ts";
import { readClarifications, selectedOption } from "./clarifications.ts";
import { createExcelTool, type ExcelDependencies } from "./tool.ts";
import { profileWorkbook, readAnalysisInputs } from "./workbook.ts";
import { runAnalysis } from "./sandbox.ts";
import { renderHtml, evidenceText, renderXlsx } from "./render.ts";
import { fixtureReport } from "./fixtures.ts";
import { EXCEL_LIMITS } from "./limits.ts";

const chart: ChartRequest = {
  kind: "chart", title: "TGA", format: "html", steps: ["그래프"], assumptions: [],
  input: { fileId: "file1", sheet: "측정", headerRow: 1, columns: [{ index: 2, name: "Temperature(℃)", key: "x" }, { index: 3, name: "Weight(%)", key: "w" }, { index: 4, name: "Deriv. Weight(%/℃)", key: "d" }] },
  x: { key: "x", label: "Temperature", unit: "℃" },
  series: [{ key: "w", label: "Weight", unit: "%", axis: "left" }, { key: "d", label: "Deriv. Weight", unit: "%/℃", axis: "right" }],
};

async function setup(count = 5) {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("측정");
  sheet.addRow(["Time", "Temperature(℃)", "Weight(%)", "Deriv. Weight(%/℃)"]);
  for (let i = 0; i < count; i++) sheet.addRow([i, 25 + i * i / count, 100 - i / count * 90, i === 3 ? 9 : i / count]);
  const input = { files: { source: [{ name: "측정.xlsx", fingerprint: "a", bytes: Buffer.from(await book.xlsx.writeBuffer()) }] }, values: { request: "전체 데이터 이중축 HTML 그래프", format: "html" }, checkpoint: {}, signal: new AbortController().signal, onTrace: vi.fn() };
  const deps: ExcelDependencies = {
    complete: vi.fn(async () => JSON.stringify(chart)),
    profile: vi.fn((bytes, _signal, query, inspection) => profileWorkbook(bytes, query, inspection)),
    analyze: vi.fn(async (files, plan) => { const { rows, ...meta } = await readAnalysisInputs(files, plan); return { ...meta, rowCount: rows.length, result: await runAnalysis(plan.code, rows) }; }),
    export: vi.fn(async report => Buffer.from(renderHtml(report))), pdf: vi.fn(async () => Buffer.from("%PDF-1.7\n%%EOF")),
  };
  return { input, deps, tool: createExcelTool(deps) };
}

it("normalizes an omitted chart without weakening numeric or source validation", () => {
  const result = { tables: [{ title: "값", columns: ["값"], rows: [{ cells: [3], sourceRows: [1] }] }], notes: [], excluded: [], charts: [] };
  expect(analysisResult.parse(result).chart).toBeNull();
  expect(() => validateResult(result, [])).toThrow("존재하지");
  expect(analysisResult.safeParse({ ...result, tables: [{ ...result.tables[0], rows: [{ cells: [Infinity], sourceRows: [1] }] }] }).success).toBe(false);
});

it("updates only the latest legacy duplicate question and keeps a correction history", () => {
  const old = [{ key: "answer3", question: "첫 질문", answer: "과거" }, { key: "answer3", question: "새 질문", answer: "이전" }];
  const result = readClarifications(old, { answer3: "수정" });
  expect(result.map(item => item.answer)).toEqual(["과거", "수정"]);
  expect(result[1].history).toEqual(["이전"]);
  expect(readClarifications(result, {})[1].answer).toBe("수정");
  const question = { key: "answer4", question: "기준", options: [{ value: "raw", label: "원본" }, { value: "loss", label: "감소량" }] };
  expect(selectedOption(question, "2번")?.value).toBe("loss");
  expect(selectedOption(question, "2")?.value).toBe("loss");
  expect(selectedOption(question, "2번 말고 원본")?.value).toBeUndefined();
});

it("does not spend an extra model turn just because three questions have been answered", async () => {
  const { input, deps, tool } = await setup();
  vi.mocked(deps.complete).mockResolvedValue(JSON.stringify({ kind: "ask", reason: "criteria", question: "감소량 기준을 선택하세요" }));
  const result = await tool.execute({ ...input, checkpoint: { clarifications: [1, 2, 3].map(n => ({ key: `answer${n}`, question: `기준 ${n}`, answer: "답" })) } });
  expect(result).toMatchObject({ status: "needs_input", replaceFields: true, fields: [{ key: "answer4" }] });
  expect(deps.complete).toHaveBeenCalledOnce();
});

it("compresses provenance across ranges without bridging missing worksheet rows or breaking old reports", () => {
  const rows = [2, 3, 5].map((row, index): InputRow => ({ id: index + 1, fileId: "file1", sheet: "측정", row, values: {} }));
  const sources = compressSources(rows);
  expect(sources).toHaveLength(2);
  expect(sourceFor(sources, 3)?.row).toBe(5);
  expect(sourceFor(sources, 4)).toBeUndefined();
  expect(sourceFor({ 1: { fileId: "file1", sheet: "옛 형식", row: 9 } }, 1)?.row).toBe(9);
});

it("draws all 10,869 measurements with numeric X and two axes in one model call and a compact checkpoint", async () => {
  const { input, deps, tool } = await setup(10869);
  const result = await tool.execute(input);
  expect(result.status).toBe("completed");
  if (result.status !== "completed") throw new Error("not completed");
  expect(deps.complete).toHaveBeenCalledOnce();
  const report = vi.mocked(deps.export).mock.calls[0][0];
  expect(report.result.tables).toEqual([]);
  const data = report.result.datasets![0];
  expect(data.rows).toHaveLength(10869);
  expect(data.rows[0].cells).toEqual([25, 100, 0]);
  expect(data.rows[3].cells[2]).toBe(9);
  expect(sourceFor(report.rowSources, 10869)?.row).toBe(10870);
  expect(JSON.stringify(report.rowSources).length).toBeLessThan(200);
  expect(JSON.stringify(result.checkpoint).length).toBeLessThan(1000000);
  expect(result.checkpoint).not.toHaveProperty("excelState.latest");
  const dom = new JSDOM(Buffer.from(result.file.bytes).toString());
  expect(dom.window.document.querySelectorAll('path[data-points="10869"]')).toHaveLength(2);
  expect(dom.window.document.querySelectorAll("tbody tr")).toHaveLength(0);
  expect(dom.window.document.body.textContent).toContain("Weight (%)");
  expect(dom.window.document.body.textContent).toContain("오른쪽 축");
  expect(dom.window.document.body.textContent).toContain("2-10870행");
  dom.window.close();
  expect(input.onTrace.mock.calls.map(([event]) => event.phase)).toEqual(["profile", "model", "analysis", "export"]);
}, 30000);

it("uses numeric spacing and breaks a line across missing source rows", async () => {
  const { input, deps, tool } = await setup(5);
  await tool.execute(input);
  const report = vi.mocked(deps.export).mock.calls[0][0];
  const data = report.result.datasets![0];
  data.rows.splice(2, 1);
  const html = renderHtml(report), dom = new JSDOM(html);
  const path = dom.window.document.querySelector('path[data-series="0"]')!.getAttribute("d")!;
  expect(path.match(/M/g)).toHaveLength(2);
  expect(path).toMatch(/^M120\.00 .* L165\.00 /); // second point is 1/16 of the numeric span, not one quarter
  expect(evidenceText(report, [1, 2, 4, 5])).toContain("2-3, 5-6행");
  dom.window.close();
});

it("shows isolated measurements instead of leaving a single-point line invisible", async () => {
  const { input, deps, tool } = await setup(1);
  await tool.execute(input);
  const dom = new JSDOM(renderHtml(vi.mocked(deps.export).mock.calls[0][0]));
  expect(dom.window.document.querySelectorAll('circle[cx="480.00"][cy="210.00"]')).toHaveLength(2);
  dom.window.close();
});

it("replays only the fixed chart template after an export failure and rejects changed sources", async () => {
  const { input, deps, tool } = await setup();
  vi.mocked(deps.export).mockRejectedValueOnce(new Error("출력 실패"));
  const result = await tool.execute(input);
  expect(result.status).toBe("needs_input");
  if (result.status !== "needs_input") throw new Error("not waiting");
  expect(result.checkpoint).not.toHaveProperty("excelState.latest");
  const resumed = { ...input, checkpoint: result.checkpoint!, values: { ...input.values, exportFormat: "html" } };
  await expect(tool.execute({ ...resumed, files: { source: [{ ...input.files.source[0], fingerprint: "changed" }] } })).rejects.toThrow("원본이 변경");
  expect(await tool.execute(resumed)).toMatchObject({ status: "completed" });
  expect(deps.complete).toHaveBeenCalledOnce();
  expect(deps.analyze).toHaveBeenCalledTimes(2);
});

it("executes a complete choice plan without a model call and respects a newer free-text revision", async () => {
  const { input, deps, tool } = await setup();
  vi.mocked(deps.complete).mockResolvedValueOnce(JSON.stringify({ kind: "ask", reason: "criteria", question: "원본 Weight로 그릴까요?", options: [{ value: "weight", label: "원본 Weight (%)", plan: chart }] }));
  const asked = await tool.execute(input);
  if (asked.status !== "needs_input") throw new Error("not waiting");
  const answer = { ...input, checkpoint: asked.checkpoint!, values: { ...input.values, answer1: "weight" }, changedKeys: ["answer1"] };
  expect(await tool.execute(answer)).toMatchObject({ status: "completed" });
  expect(deps.complete).toHaveBeenCalledOnce();
  await tool.execute({ ...answer, values: { ...answer.values, format: "pdf" }, changedKeys: ["format"] });
  expect(deps.complete).toHaveBeenCalledTimes(2);
  await tool.execute({ ...answer, values: { ...answer.values, revision: "다른 시트로 변경" }, changedKeys: ["revision"] });
  expect(deps.complete).toHaveBeenCalledTimes(3);
  expect(JSON.parse(vi.mocked(deps.complete).mock.calls[2][1]).latestInstruction).toEqual({ revision: "다른 시트로 변경" });
});

it("rejects impossible ranges and unsupported XLSX before analysis, and flags unit mismatches", async () => {
  const plan = compileChart(chart);
  expect(() => preflight({ ...plan, inputs: [{ ...plan.inputs[0], lastDataRow: EXCEL_LIMITS.inputRows + 2 }] }, [{ fileId: "file1", sheets: [{ name: "측정", rows: 50000, columns: 4 }] }])).toThrow("최대");
  expect(() => compileChart({ ...chart, series: [{ ...chart.series[0], unit: "℃" }] })).toThrow("원본 단위");
  const { input, deps, tool } = await setup();
  vi.mocked(deps.complete).mockResolvedValue(JSON.stringify({ ...chart, format: "xlsx" }));
  expect(await tool.execute(input)).toMatchObject({ status: "failed", code: "UNSUPPORTED" });
  expect(deps.complete).toHaveBeenCalledOnce();
  expect(deps.analyze).not.toHaveBeenCalled();
  const report = { ...fixtureReport, result: { ...fixtureReport.result, charts: [{ type: "line" as const, title: "TGA", table: 0, x: 0, y: 1, dataset: true }] } };
  await expect(renderXlsx(report)).rejects.toThrow("HTML");
});

it("distinguishes a truncated model response and records only safe model timing fields", async () => {
  const { input, deps } = await setup();
  vi.mocked(deps.complete).mockResolvedValueOnce('{"kind":"execute",');
  deps.callInfo = vi.fn().mockReturnValueOnce({ finishReason: "length", modelAlias: "test", latencyMs: 100, promptTokens: 20, completionTokens: 10 }).mockReturnValueOnce(undefined);
  const result = await createExcelTool(deps).execute(input);
  expect(result.status).toBe("completed");
  expect(JSON.parse(vi.mocked(deps.complete).mock.calls[1][1]).failure).toContain("잘렸습니다");
  const metrics = JSON.stringify(input.onTrace.mock.calls);
  expect(metrics).toContain('"finishReason":"length"');
  expect(metrics).not.toContain(input.values.request);
});

it("records a failed model call without regenerating a plan", async () => {
  const { input, deps, tool } = await setup();
  vi.mocked(deps.complete).mockRejectedValue(new Error("network unavailable"));
  await expect(tool.execute(input)).rejects.toThrow("network unavailable");
  expect(deps.complete).toHaveBeenCalledOnce();
  expect(input.onTrace).toHaveBeenCalledWith(expect.objectContaining({ phase: "model", errorCode: "MODEL_TRANSPORT", durationMs: expect.any(Number) }));
});

it.each(["loss100", "lossInitial"] as const)("applies the explicitly selected %s definition and preserves evidence", async transform => {
  const plan = compileChart({ ...chart, series: [{ ...chart.series[0], transform, label: "Weight Loss (%)" }] });
  const rows = [90, 80].map((w, i) => ({ id: i+1, fileId: "file1", sheet: "측정", row: i+2, values: { x: i+25, w } }));
  const result = await runAnalysis(plan.code, rows);
  expect(result.datasets![0].rows.map(row => row.cells[1])).toEqual(transform === "loss100" ? [10, 20] : [0, 10]);
  expect(result.datasets![0].columns[1]).toBe("Weight Loss (%)");
  expect(result.datasets![0].rows.map(row => row.sourceRows)).toEqual([[1], [2]]);
});
