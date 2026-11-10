// Bundle with esbuild --platform=node --packages=external --format=cjs; run with Electron.
// Arguments: TGA.xlsx, worksheet, output directory, built excel.worker.js. Set EXCEL_SMOKE_LIVE_MODEL=1 for the small revision prompt.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { app } from "electron";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import sharp from "sharp";
import "dotenv/config";
import { createLiteLLMClient, resolveModelAlias } from "../electron/agent/modelClient.ts";
import { DEFAULT_POLICY_PROFILE } from "../electron/agent/policy.ts";
import { createExcelTool, type ExcelJobs } from "../electron/excel/tool.ts";
import { createExcelWorker } from "../electron/excel/workerClient.ts";
import { captureChartPng, printReportPdf } from "../electron/excel/pdf.ts";
import { chartSvg } from "../electron/excel/render.ts";
import type { BusinessTrace } from "../electron/business/contracts.ts";
import type { ChartRequest, Report } from "../electron/excel/contracts.ts";

app.on("window-all-closed", () => undefined);
async function main() {
  const [file, sheetName, output, workerPath] = process.argv.slice(2);
  assert(file && sheetName && output && workerPath, "Expected XLSX, sheet, output directory and worker path");
  const temporary = await mkdtemp(join(tmpdir(), "ketchupe-revision-smoke-"));
  app.setPath("userData", temporary);
  await app.whenReady();
  const worker = createExcelWorker(resolve(workerPath));
  try {
    const bytes = await readFile(file), fingerprint = createHash("sha256").update(bytes).digest("hex");
    const book = new ExcelJS.Workbook(); await book.xlsx.load(bytes as never);
    const sheet = book.getWorksheet(sheetName)!;
    const plan: ChartRequest = {
      kind: "chart", title: "TGA", format: "html", steps: ["전체 측정값"], assumptions: ["C열 원본 Weight (%)"],
      input: { fileId: "file1", sheet: sheetName, headerRow: 1, firstDataRow: 2, lastDataRow: sheet.rowCount, columns: [2,3,4].map((index,i) => ({ index, name: String(sheet.getCell(1,index).value), key: ["x","w","d"][i] })) },
      x: { key: "x", label: "Temperature", unit: "℃" }, series: [{ key: "w", label: "Weight", unit: "%", axis: "left" }, { key: "d", label: "Deriv. Weight", unit: "%/℃", axis: "right" }],
    };
    const live = process.env.EXCEL_SMOKE_LIVE_MODEL === "1";
    const baseURL = process.env.LITELLM_BASE_URL ?? "https://centinels.ml2-alpha.com/v1/";
    if (live) assert(process.env.LITELLM_API_KEY, "LITELLM_API_KEY missing");
    const modelAlias = live ? await resolveModelAlias(baseURL, process.env.LITELLM_API_KEY!, process.env.LITELLM_MODEL_ALIAS) : "fixture";
    const client = live ? createLiteLLMClient({ baseURL, apiKey: process.env.LITELLM_API_KEY! }) : undefined;
    let report: Report | undefined, profiles = 0, planners = 0, revisions = 0;
    const traces: BusinessTrace[] = [], prompts: { systemChars: number; promptChars: number; latencyMs: number }[] = [];
    const jobs: ExcelJobs = {
      profile: (bytes, signal, query, inspection) => { profiles++; return worker.run({ kind: "profile", bytes, query, inspection }, signal); },
      analyze: (files, plan, signal) => worker.run({ kind: "analyze", files, plan }, signal),
      export: (value, format, signal) => { report = value; return worker.run({ kind: "export", report: value, format }, signal); },
    };
    const patches = [
      { kind: "view", patch: { charts: { "0": { axes: { left: { min: 0, max: 100, tickStep: 20, decimals: 0 }, right: { min: 0, max: 1.2, tickStep: .2, decimals: 1 }, x: { tickValues: [0,200,400,600,800] } } } } } },
      { kind: "view", patch: { charts: { "0": { annotations: [{ series: 1, kind: "max", label: "Tmax", scope: "selectedData" }] } } } },
      { kind: "view", patch: { charts: { "0": { title: "TGA 열분해 분석", description: "D열 최대값에서 측정한 Temperature를 Tmax로 표시했습니다." } } }, formats: ["html","pdf","png","pptx"] },
    ];
    const tool = createExcelTool({ ...jobs, pdf: printReportPdf, png: captureChartPng,
      complete: async () => { planners++; return JSON.stringify(plan); },
      revise: async (system, prompt, signal) => {
        const started = Date.now();
        const response = client ? await client.complete({ system, prompt, purpose: "excel", maxOutputTokens: 2000 }, { ...DEFAULT_POLICY_PROFILE, modelAlias }, signal) : JSON.stringify(patches[revisions]);
        prompts.push({ systemChars: system.length, promptChars: prompt.length, latencyMs: Date.now()-started });
        revisions++;
        await writeFile(join(output, `revision-${revisions}.json`), response);
        return response;
      }, callInfo: signal => client?.lastCallFor?.(signal) ?? client?.lastCall,
    });
    await mkdir(output, { recursive: true });
    const input = { files: { source: [{ bytes, fingerprint, name: basename(file) }] }, values: { request: "원본 Weight (%) TGA 그래프를 HTML로 만들어줘" }, checkpoint: {}, signal: AbortSignal.timeout(180000), onTrace: (event: BusinessTrace) => traces.push(event) };
    let result = await tool.execute(input);
    assert.equal(result.status, "completed");
    if (result.status !== "completed") throw new Error("initial failed");
    const instructions = [
      "왼쪽 Y축은 0~100 간격 20, 오른쪽 Y축은 0.0~1.2 간격 0.2 소수 한 자리. X축 눈금은 0,200,400,600,800으로 맞춰줘. 데이터는 전부 유지해줘.",
      "앞선 축 설정은 그대로 두고 D열 Deriv. Weight 최대값이 나오는 Temperature를 Tmax로 표시해줘.",
      "제목을 TGA 열분해 분석으로, 설명은 D열 최대값에서 측정한 Temperature를 Tmax로 표시했습니다. 로 바꾸고 HTML, PDF, PNG, PPTX로 저장해줘.",
    ];
    const durations: number[] = [];
    for (const instruction of instructions) {
      const started = Date.now();
      result = await tool.execute({ ...input, checkpoint: JSON.parse(JSON.stringify(result.checkpoint)), userText: instruction, values: { ...input.values, revision: instruction } });
      durations.push(Date.now()-started);
      assert.equal(result.status, "completed", JSON.stringify(result.status === "needs_input" ? result.question : result.status));
      if (result.status !== "completed") throw new Error("revision failed");
    }
    assert(report);
    const view = report.view!.charts["0"];
    assert.equal(view.axes!.right!.decimals, 1);
    assert.equal(view.axes!.left!.tickStep, 20);
    assert.equal(view.annotations![0].series, 1);
    assert.equal(view.title, "TGA 열분해 분석");
    const data = report.result.datasets![0].rows;
    let max = -Infinity, expectedX = NaN;
    for (let row = 2; row <= sheet.rowCount; row++) {
      const x = sheet.getCell(row,2).value, value = sheet.getCell(row,4).value;
      if (typeof value === "number" && typeof x === "number" && value > max) { max = value; expectedX = x; }
    }
    const svg = chartSvg(report);
    assert(svg.includes(`data-x="${expectedX}"`));
    assert(svg.includes('data-points="10869"'));
    assert.equal((svg.match(/data-axis="right"/g) ?? []).length, 7);
    assert.equal(data.length, 10869);
    for (const artifact of [result.file, ...(result.additionalFiles ?? [])]) {
      await tool.validateOutput!(artifact, input.signal);
      await writeFile(join(output, artifact.name), artifact.bytes);
      if (artifact.name.endsWith(".png")) {
        const pixels = await sharp(artifact.bytes).removeAlpha().raw().toBuffer();
        let red = 0, blue = 0;
        for (let i = 0; i < pixels.length; i += 3) { if (pixels[i] > 160 && pixels[i+1] < 120 && pixels[i+2] < 120) red++; if (pixels[i+2] > 160 && pixels[i] < 120) blue++; }
        assert(red > 1000 && blue > 1000, "both chart series must finish painting");
        const stats = await sharp(artifact.bytes).stats();
        assert(stats.channels.some(channel => channel.stdev > 5), "blank capture");
      }
      if (artifact.name.endsWith(".pptx")) {
        const zip = await JSZip.loadAsync(artifact.bytes);
        assert((await zip.file("ppt/slides/slide1.xml")!.async("string")).includes("TGA 열분해 분석"));
      }
    }
    assert.equal(profiles, 1); assert.equal(planners, 1); assert.equal(revisions, 3);
    assert.equal(createHash("sha256").update(await readFile(file)).digest("hex"), fingerprint);
    const metrics = { modelAlias, profiles, planners, revisions, rows: data.length, max, expectedX, durations, prompts, traces, checkpointChars: JSON.stringify(result.checkpoint).length };
    await writeFile(join(output, "metrics.json"), JSON.stringify(metrics, null, 2));
    console.log(JSON.stringify(metrics));
  } finally { worker.close(); await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined); }
}
void main().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
