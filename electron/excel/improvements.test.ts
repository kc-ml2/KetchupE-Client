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
import { chartOption, chartSvg } from "./chart.ts";
import type { Report } from "./contracts.ts";
import { fixtureReport } from "./fixtures.ts";
import { EXCEL_LIMITS } from "./limits.ts";

const chart: ChartRequest = {
  kind: "chart", title: "TGA", format: "html", steps: ["그래프"], assumptions: [],
  input: { fileId: "file1", sheet: "측정", headerRow: 1, columns: [{ index: 2, name: "Temperature(℃)", key: "x" }, { index: 3, name: "Weight(%)", key: "w" }, { index: 4, name: "Deriv. Weight(%/℃)", key: "d" }] },
  x: { key: "x", label: "Temperature", unit: "℃" },
  series: [{ key: "w", label: "Weight", unit: "%", axis: "left" }, { key: "d", label: "Deriv. Weight", unit: "%/℃", axis: "right" }],
};

/** Chart assertions read the ECharts option: series data, axis settings and marks, not SVG coordinates. */
const drawn = (report: Report, index = 0) => {
  const { option, notes } = chartOption(report, (report.result.charts ?? [report.result.chart!])[index]);
  const axes = { x: option.xAxis!, left: [option.yAxis!].flat()[0], right: [option.yAxis!].flat()[1] };
  const ticks = (side: keyof typeof axes) => (axes[side].axisLabel as { customValues?: number[]; formatter: (value: number) => string });
  return { option, notes, axes, ticks, lines: option.series.filter(series => series.type === "line") };
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
  expect(drawn(report).lines.map(series => series.data.length)).toEqual([10869, 10869]);
  expect(dom.window.document.querySelectorAll("svg path").length).toBeGreaterThan(2);
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
  const points = drawn(report).lines[0].data as [number, number | null][];
  expect(points.map(point => point[1] === null)).toEqual([false, false, true, false, false]); // the pen lifts once, no point is dropped
  expect(points[1][0]).toBe(25.2); // numeric X keeps the measured spacing, not one step per row
  expect(drawn(report).axes.x.type).toBe("value");
  expect(chartSvg(report)).toMatch(/<path d="M[^"]*L[^"]*M[^"]*L[^"]*"[^>]*stroke="#2563eb"/);
  expect(evidenceText(report, [1, 2, 4, 5])).toContain("2-3, 5-6행");
});

it("shows isolated measurements instead of leaving a single-point line invisible", async () => {
  const { input, deps, tool } = await setup(1);
  await tool.execute(input);
  const single = vi.mocked(deps.export).mock.calls[0][0];
  expect(drawn(single).lines.map(series => series.showSymbol)).toEqual([true, true]);
  const many = await setup(100);
  await many.tool.execute(many.input);
  const report = vi.mocked(many.deps.export).mock.calls[0][0];
  report.result.datasets![0].rows.splice(51, 1);
  report.result.datasets![0].rows.splice(49, 1); // row 51 now stands alone between two gaps
  const isolated = drawn(report).option.series.filter(series => series.type === "scatter");
  expect(isolated.map(series => series.data)).toEqual([[[25 + 50 * 50 / 100, 55]], [[25 + 50 * 50 / 100, .5]]]);
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

it("accumulates axis, peak and title edits across 22 saved revisions without profiling or replanning", async () => {
  const { input, deps } = await setup();
  const revise = vi.fn<ExcelDependencies["complete"]>();
  const tool = createExcelTool({ ...deps, revise });
  const initial = await tool.execute(input);
  if (initial.status !== "completed") throw new Error("not completed");
  let checkpoint = initial.checkpoint!;
  const axes = { left: { min: 0, max: 100, tickStep: 20 }, right: { min: 0, max: 10, tickStep: 2, decimals: 1 } };
  for (let i = 0; i < 22; i++) {
    revise.mockResolvedValueOnce(JSON.stringify({ kind: "view", patch: { charts: { "0": i === 0 ? { axes } : i === 1 ? { annotations: [{ series: 1, kind: "max", label: "Tmax", scope: "selectedData" }] } : { title: `수정 ${i}` } } } }));
    const result = await tool.execute({ ...input, checkpoint: JSON.parse(JSON.stringify(checkpoint)), values: { ...input.values, revision: `수정 ${i}` }, userText: `수정 ${i}` });
    if (result.status !== "completed") throw new Error(JSON.stringify(result));
    checkpoint = result.checkpoint!;
    expect(checkpoint).toMatchObject({ excelState: { view: { charts: { "0": { axes } } } } });
    if (i >= 1) expect(checkpoint).toHaveProperty("excelState.view.charts.0.annotations.0.label", "Tmax");
  }
  expect(deps.complete).toHaveBeenCalledOnce();
  expect(deps.profile).toHaveBeenCalledOnce();
  expect(revise).toHaveBeenCalledTimes(22);
  const prompt = revise.mock.calls[1][1];
  expect(prompt.length).toBeLessThan(4000);
  expect(JSON.parse(prompt)).not.toHaveProperty("computed");
  expect(prompt).not.toContain("return {");
  const chartView = drawn(vi.mocked(deps.export).mock.calls.at(-1)![0]);
  expect(chartView.ticks("right").customValues!.map(chartView.ticks("right").formatter)).toEqual(["0.0", "2.0", "4.0", "6.0", "8.0", "10.0"]);
  expect(chartView.axes.right).toMatchObject({ min: 0, max: 10 });
  expect(chartView.lines[1].markPoint).toMatchObject({ data: [{ coord: [26.8, 9], label: { formatter: "Tmax: X=26.8, Y=9" } }] });
});

it("preserves resolved changes while a mixed follow-up answers the remaining question", async () => {
  const { input, deps } = await setup();
  const revise = vi.fn<ExcelDependencies["complete"]>()
    .mockResolvedValueOnce(JSON.stringify({ kind: "ask", question: "어느 시리즈의 최대값인가요?", patch: { charts: { "0": { axes: { left: { min: 0, max: 100, tickStep: 20 } } } } } }))
    .mockResolvedValueOnce(JSON.stringify({ kind: "view", patch: { charts: { "0": { title: "수정된 TGA", annotations: [{ series: 1, kind: "max", label: "Tmax" }] } } } }));
  const tool = createExcelTool({ ...deps, revise });
  const original = await tool.execute(input);
  if (original.status !== "completed") throw new Error("not completed");
  const asked = await tool.execute({ ...input, checkpoint: original.checkpoint!, userText: "왼쪽 축 0~100 간격20 그리고 최대점 온도" });
  if (asked.status !== "needs_input") throw new Error("not waiting");
  expect((asked.checkpoint!.excelState as { view?: unknown }).view).toBeUndefined();
  const result = await tool.execute({ ...input, checkpoint: asked.checkpoint!, values: { ...input.values, revisionAnswer: "D열 최대값, 제목도 수정된 TGA로" }, changedKeys: ["revisionAnswer"] });
  expect(result).toMatchObject({ status: "completed", checkpoint: { excelState: { view: { charts: { "0": { title: "수정된 TGA", axes: { left: { tickStep: 20 } }, annotations: [{ label: "Tmax" }] } } } } } });
  expect(JSON.parse(revise.mock.calls[1][1]).userText).toContain("D열 최대값");
  expect(deps.complete).toHaveBeenCalledOnce();
});

it("does not loop or discard the last successful view when a patch is invalid", async () => {
  const { input, deps } = await setup();
  const revise = vi.fn<ExcelDependencies["complete"]>().mockResolvedValue('{"kind":"view","patch":{"charts":{"0":{"axes":{"left":{"min":100,"max":0}}}}}}');
  const tool = createExcelTool({ ...deps, revise });
  const original = await tool.execute(input);
  if (original.status !== "completed") throw new Error("not completed");
  const state = JSON.stringify(original.checkpoint);
  const result = await tool.execute({ ...input, checkpoint: original.checkpoint!, userText: "축 변경" });
  expect(result).toMatchObject({ status: "needs_input" });
  expect(JSON.stringify(original.checkpoint)).toBe(state);
  expect(revise).toHaveBeenCalledOnce();
  expect(deps.complete).toHaveBeenCalledOnce();
  expect(deps.analyze).toHaveBeenCalledOnce();
});

it("uses zero model calls for a format-only form change and produces a validated image/PPTX", async () => {
  const { input, deps } = await setup();
  const sharp = (await import("sharp")).default;
  const png = vi.fn(async (svg: string) => sharp(Buffer.from(svg)).png().toBuffer());
  const tool = createExcelTool({ ...deps, png });
  const original = await tool.execute(input);
  if (original.status !== "completed") throw new Error("not completed");
  expect(original.previews).toHaveLength(1);
  const result = await tool.execute({ ...input, checkpoint: original.checkpoint!, values: { ...input.values, format: "pptx" }, changedKeys: ["format"] });
  if (result.status !== "completed") throw new Error(JSON.stringify(result));
  expect(result.file.name).toMatch(/\.pptx$/);
  for (const file of [result.file, ...result.additionalFiles!]) await tool.validateOutput!(file, input.signal);
  expect(deps.complete).toHaveBeenCalledOnce();
  const zip = await (await import("jszip")).default.loadAsync(result.file.bytes);
  const xml = await zip.file("ppt/slides/slide1.xml")!.async("string");
  expect(xml).toContain("<a:t>TGA</a:t>");
  expect(xml).toContain("<p:pic>");
  expect(zip.file(/^ppt\/media\/.*png$/)).toHaveLength(1);
}, 30000); // Native SVG/font initialization can exceed 5 seconds on Windows CI.

it("applies integer labels on all three axes and a peak without a model-supplied annotation label", async () => {
  const { input, deps } = await setup();
  vi.mocked(deps.complete).mockResolvedValue(JSON.stringify({ ...chart, view: { charts: { "0": { title: "이전 제목", axes: { left: { min: 0, max: 100 } } } } } }));
  const revise = vi.fn<ExcelDependencies["complete"]>().mockResolvedValue(JSON.stringify({ kind: "view", patch: { charts: { "0": {
    axes: { x: { decimals: 0 }, left: { decimals: 0 }, right: { decimals: 0 } }, annotations: [{ series: 1, kind: "max" }],
  } } } }));
  const tool = createExcelTool({ ...deps, revise });
  const original = await tool.execute(input);
  if (original.status !== "completed") throw new Error("not completed");
  const result = await tool.execute({ ...input, checkpoint: original.checkpoint!, userText: "weight, temperature, Deriv.Weight 축 scale값들은 소수점 없이 맞춰주고, Deriv.Weight의 max peak를 그래프에 표시해줘." });
  expect(result).toMatchObject({ status: "completed", checkpoint: { excelState: { view: { charts: { "0": {
    title: "이전 제목", axes: { x: { decimals: 0 }, left: { min: 0, max: 100, decimals: 0 }, right: { decimals: 0 } }, annotations: [{ series: 1, kind: "max", label: "최대점", scope: "selectedData" }],
  } } } } } });
  if (result.status !== "completed") throw new Error("not completed");
  const chartView = drawn(vi.mocked(deps.export).mock.calls.at(-1)![0]);
  for (const axis of ["x", "left", "right"] as const) {
    expect(chartView.axes[axis].minInterval).toBe(1); // whole-number ticks cannot repeat a rounded label
    expect(chartView.ticks(axis).formatter(12.6)).toBe("13");
  }
  expect(chartView.axes.left).toMatchObject({ min: 0, max: 100 });
  expect(chartView.lines[1].markPoint).toMatchObject({ data: [{ coord: [26.8, 9] }] });
  expect(Buffer.from(result.file.bytes).toString()).toContain("최대점: X=27, Y=9");
  expect(revise).toHaveBeenCalledOnce();
  expect(deps.complete).toHaveBeenCalledOnce();
  expect(deps.profile).toHaveBeenCalledOnce();
});

it.each([
  { code: "REVISION_MODEL", response: null, finishReason: "stop", message: "응답을 받지 못했습니다" },
  { code: "REVISION_TRUNCATED", response: "{", finishReason: "length", message: "길이 제한" },
  { code: "REVISION_JSON", response: "invalid JSON", finishReason: "stop", message: "응답 형식" },
  { code: "REVISION_SCHEMA", response: '{"kind":"view","patch":{"charts":{"0":{"annotations":[{"kind":"max"}]}}}}', finishReason: "stop", message: "응답 형식" },
])("reports $code without blaming the user or replanning", async ({ code, response, finishReason, message }) => {
  const { input, deps } = await setup();
  const revise = vi.fn<ExcelDependencies["complete"]>(async () => { if (response === null) throw new Error("private gateway detail"); return response; });
  const tool = createExcelTool({ ...deps, revise, callInfo: () => ({ purpose: "excel", modelAlias: "fixture", latencyMs: 1, promptTokens: 1, completionTokens: 1, finishReason: revise.mock.calls.length ? finishReason : "stop" }) });
  const original = await tool.execute(input);
  if (original.status !== "completed") throw new Error("not completed");
  const before = JSON.stringify(original.checkpoint);
  const result = await tool.execute({ ...input, checkpoint: original.checkpoint!, userText: "모든 축 소수점 제거" });
  expect(result).toMatchObject({ status: "needs_input", question: expect.stringContaining(message) });
  expect(JSON.stringify(original.checkpoint)).toBe(before);
  expect(input.onTrace).toHaveBeenCalledWith(expect.objectContaining({ phase: "error", operation: "revision", errorCode: code }));
  expect(JSON.stringify(input.onTrace.mock.calls)).not.toContain("private gateway detail");
  expect(revise).toHaveBeenCalledOnce();
  expect(deps.complete).toHaveBeenCalledOnce();
  expect(deps.analyze).toHaveBeenCalledOnce();
});

it("bounds ticks, preserves source data outside the view, and finds tied peaks in acquisition order", async () => {
  const { input, deps, tool } = await setup();
  await tool.execute(input);
  const report = structuredClone(vi.mocked(deps.export).mock.calls[0][0]);
  const rows = report.result.datasets![0].rows;
  rows[0].cells = [0, 100, -1]; rows[1].cells = [900, 80, 12]; rows[2].cells = [300, 60, 12];
  report.view = { charts: { "0": { axes: { x: { tickValues: [0,200,400,600,800] }, right: { min: 0, max: 10, tickStep: 2, decimals: 1 } }, annotations: [{ series: 1, kind: "max", label: "Tmax", scope: "selectedData" }] } } };
  const before = JSON.stringify(rows);
  const html = renderHtml(report);
  expect(html).toContain("Tmax: X=900, Y=12");
  expect(html).toContain("동률 2점 중 첫 측정점");
  expect(html).toContain("표시 범위 밖");
  expect(JSON.stringify(rows)).toBe(before);
  report.view.charts["0"].axes!.right!.tickStep = .001;
  expect(() => renderHtml(report)).toThrow("최대 50개");
});

it("fixes Date and random per execution without changing explicit dates or leaking host APIs", async () => {
  const rows: InputRow[] = [{ id: 1, fileId: "file1", sheet: "측정", row: 2, values: {} }];
  const code = `return { tables: [{title:"시간",columns:["now","date","random","explicit"],rows:[{cells:[Date.now(),new Date().getTime(),Math.random(),new Date('2026-01-01T00:00:00Z').getUTCFullYear()],sourceRows:[1]}]}], excluded:[],notes:[] };`;
  const first = await runAnalysis(code, rows, undefined, 123456789);
  expect(await runAnalysis(code, rows, undefined, 123456789)).toEqual(first);
  expect(first.tables[0].rows[0].cells).toEqual([123456789,123456789,expect.any(Number),2026]);
  expect((await runAnalysis(code, rows, undefined, 987654321)).tables[0].rows[0].cells[0]).toBe(987654321);
});

it("includes the floating-point upper tick (1.2 at step 0.2) and restores automatic axes", async () => {
  const { chartScale } = await import("./chart.ts");
  const { mergeView } = await import("./view.ts");
  expect(chartScale([-.01,1.19], { min: 0, max: 1.2, tickStep: .2 }).ticks).toHaveLength(7);
  expect(chartScale([-.01,1.19], { min: 0, max: 1.2, tickStep: .2 }).ticks.at(-1)).toBe(1.2);
  expect(chartScale([-.0004,1.190857], { decimals: 0 })).toMatchObject({ min: -.0004, max: 1.190857, ticks: [0,1] });
  const view = mergeView(undefined, { charts: { "0": { axes: { right: { min: 0, max: 1.2, tickStep: .2 } } } } });
  expect(mergeView(view, { charts: { "0": { axes: { right: null } } } }).charts["0"].axes).toEqual({});
  const named = mergeView(undefined, { charts: { "0": { annotations: [{ series: 1, kind: "max", scope: "selectedData", label: "Tmax" }] } } });
  expect(mergeView(named, { charts: { "0": { annotations: [{ series: 1, kind: "max", scope: "selectedData" }] } } }).charts["0"].annotations?.[0].label).toBe("Tmax");
});

it("accepts an initial view outside chartSpec and carries it into the first result", async () => {
  const { input, deps, tool } = await setup();
  vi.mocked(deps.complete).mockResolvedValue(JSON.stringify({ ...chart, view: { charts: { "0": { axes: { right: { decimals: 1, min: 0, max: 10 } }, annotations: [{ series: 1, kind: "max", label: "Tmax" }] } } } }));
  const result = await tool.execute(input);
  expect(result).toMatchObject({ status: "completed", checkpoint: { excelState: { view: { charts: { "0": { axes: { right: { decimals: 1 } } } } } } } });
  expect(deps.complete).toHaveBeenCalledOnce();
});

it("rejects a replay with different results instead of publishing changed numbers", async () => {
  const { input, deps } = await setup();
  const tool = createExcelTool({ ...deps, revise: async () => '{"kind":"view","patch":{"charts":{"0":{"title":"다른 제목"}}}}' });
  const initial = await tool.execute(input);
  if (initial.status !== "completed") throw new Error("not completed");
  const original = vi.mocked(deps.analyze).mock.results[0];
  const changed = structuredClone(await original.value);
  changed.result.datasets![0].rows[0].cells[1] = 42;
  vi.mocked(deps.analyze).mockResolvedValue(changed);
  const result = await tool.execute({ ...input, checkpoint: initial.checkpoint!, userText: "제목 변경" });
  expect(result).toMatchObject({ status: "needs_input", question: expect.stringContaining("이전 수치와 달라") });
  expect(deps.export).toHaveBeenCalledOnce();
});
