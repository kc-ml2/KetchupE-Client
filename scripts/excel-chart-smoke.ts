// Bundle with esbuild (--platform=node --packages=external --format=cjs), then run with Electron.
// Arguments: XLSX path, worksheet name, output directory, built excel.worker.js path.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { app, BrowserWindow } from "electron";
import ExcelJS from "exceljs";
import "dotenv/config";
import { createLiteLLMClient, resolveModelAlias } from "../electron/agent/modelClient.ts";
import { DEFAULT_POLICY_PROFILE } from "../electron/agent/policy.ts";
import { createExcelTool, type ExcelJobs } from "../electron/excel/tool.ts";
import { createExcelWorker } from "../electron/excel/workerClient.ts";
import { printReportPdf } from "../electron/excel/pdf.ts";
import { sourceFor } from "../electron/excel/sources.ts";
import type { BusinessTrace } from "../electron/business/contracts.ts";
import type { ChartRequest, Report } from "../electron/excel/contracts.ts";

// PDF printing closes its temporary window before the remaining assertions run.
app.on("window-all-closed", () => undefined);

async function main() {
  const [file, sheetName, output, workerPath] = process.argv.slice(2);
  assert(file && sheetName && output && workerPath, "Expected XLSX, worksheet, output directory, worker path");
  const temporary = await mkdtemp(join(tmpdir(), "ketchupe-chart-smoke-"));
  app.setPath("userData", temporary);
  await app.whenReady();
  const worker = createExcelWorker(resolve(workerPath));
  try {
    const bytes = await readFile(file), fingerprint = createHash("sha256").update(bytes).digest("hex");
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(bytes as never);
    const sheet = book.getWorksheet(sheetName);
    assert(sheet, "Worksheet missing");
    const keys = ["x", "weight", "derivative"];
    const columns = [2, 3, 4].map((index, i) => ({ index, name: String(sheet.getCell(1, index).value), key: keys[i] }));
    const plan: ChartRequest = {
      kind: "chart", title: "TGA 전체 데이터 검증", format: "html", formats: ["html", "pdf"],
      steps: ["전체 데이터 그래프"], assumptions: ["검증 시나리오: C열 원본 Weight (%)를 변환 없이 표시"],
      input: { fileId: "file1", sheet: sheetName, headerRow: 1, firstDataRow: 2, lastDataRow: sheet.rowCount, columns },
      x: { key: "x", label: "Temperature", unit: "℃" },
      series: [{ key: "weight", axis: "left", label: "Weight", unit: "%" }, { key: "derivative", axis: "right", label: "Deriv. Weight", unit: "%/℃" }],
    };
    const timings: BusinessTrace[] = [];
    let calls = 0, report: Report | undefined;
    const live = process.env.EXCEL_SMOKE_LIVE_MODEL === "1";
    const baseURL = process.env.LITELLM_BASE_URL ?? "https://centinels.ml2-alpha.com/v1/";
    if (live) assert(process.env.LITELLM_API_KEY, "LITELLM_API_KEY is required for live validation");
    const modelAlias = live ? await resolveModelAlias(baseURL, process.env.LITELLM_API_KEY!, process.env.LITELLM_MODEL_ALIAS) : "fixed plan (no network)";
    const client = live ? createLiteLLMClient({ baseURL, apiKey: process.env.LITELLM_API_KEY! }) : undefined;
    const jobs: ExcelJobs = {
      profile: (bytes, signal, query, inspection) => worker.run({ kind: "profile", bytes, query, inspection }, signal),
      analyze: (files, plan, signal) => worker.run({ kind: "analyze", files, plan }, signal),
      export: (value, format, signal) => { report = value; return worker.run({ kind: "export", report: value, format }, signal); },
    };
    const started = Date.now();
    await mkdir(output, { recursive: true });
    const tool = createExcelTool({ ...jobs, complete: async (system, prompt, signal) => {
      calls++;
      const response = client ? await client.complete({ system, prompt, purpose: "excel", maxOutputTokens: 10000 }, { ...DEFAULT_POLICY_PROFILE, modelAlias }, signal) : JSON.stringify(plan);
      if (live) await writeFile(join(output, `model-${calls}.json`), response);
      return response;
    }, callInfo: () => client?.lastCall, pdf: printReportPdf });
    const input = {
      files: { source: [{ bytes, fingerprint, name: basename(file) }] }, values: { request: `시트 '${sheetName}'에서 B열 Temperature (℃)를 X축, C열 ${live ? "Weight Loss (℃)" : "원본 Weight (%)"}를 Y1축, D열 Deriv. Weight (%/℃)를 Y2축으로 하여 전체 행을 HTML과 PDF 두 파일의 이중축 그래프로 만들어줘.` },
      checkpoint: {}, signal: AbortSignal.timeout(300000), onTrace: (event: BusinessTrace) => timings.push(event),
    };
    let result = await tool.execute(input);
    if (live) {
      assert.equal(result.status, "needs_input", "Conflicting Weight Loss units must be clarified");
      if (result.status !== "needs_input") throw new Error("Expected clarification");
      const key = result.fields.find(field => field.type === "text")?.key;
      assert(key, "Expected a free-text clarification");
      result = await tool.execute({ ...input, checkpoint: result.checkpoint!, changedKeys: [key], values: { ...input.values, [key]: "C열은 원본 Weight (%)를 그대로 사용해줘. Weight Loss 변환 없이 전체 10,869행을 숫자형 온도 X축과 좌우 Y축으로 표시하고 HTML, PDF 둘 다 만들어줘." } });
    }
    assert.equal(result.status, "completed", JSON.stringify(result.status === "needs_input" ? result.question : result.status === "failed" ? result.message : ""));
    if (result.status !== "completed" || !report) throw new Error("No report");
    if (!live) assert.equal(calls, 1);
    const data = report.result.datasets![0];
    const expected = [];
    for (let row = 2; row <= sheet.rowCount; row++) {
      const cells = [2, 3, 4].map(col => sheet.getCell(row, col).value);
      if (cells.every(value => typeof value === "number")) expected.push({ row, cells });
    }
    assert.equal(data.rows.length, expected.length);
    for (let i = 0; i < expected.length; i++) {
      assert.deepEqual(data.rows[i].cells, expected[i].cells);
      assert.equal(sourceFor(report.rowSources, data.rows[i].sourceRows[0])?.row, expected[i].row);
    }
    assert(JSON.stringify(result.checkpoint).length < 1000000);
    assert.equal(createHash("sha256").update(await readFile(file)).digest("hex"), fingerprint);
    await mkdir(output, { recursive: true });
    for (const artifact of [result.file, ...(result.additionalFiles ?? [])]) await writeFile(join(output, artifact.name), artifact.bytes);
    const preview = new BrowserWindow({ show: false, width: 1100, height: 1250, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, backgroundThrottling: false } });
    try {
      await preview.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(Buffer.from(result.file.bytes).toString())}`);
      // A first offscreen capture can precede the last SVG paint in Chromium.
      await preview.webContents.capturePage();
      await new Promise(resolve => setTimeout(resolve, 200));
      await writeFile(join(output, "preview.png"), (await preview.webContents.capturePage()).toPNG());
    } finally { preview.destroy(); }
    const metrics = { model: modelAlias, modelCalls: calls, dataRows: expected.length, checkpointChars: JSON.stringify(result.checkpoint).length, sourceChars: JSON.stringify(report.rowSources).length, elapsedMs: Date.now() - started, timings, outputs: [result.file, ...(result.additionalFiles ?? [])].map(file => ({ name: file.name, bytes: file.bytes.length })) };
    await writeFile(join(output, "metrics.json"), JSON.stringify(metrics, null, 2));
    console.log(JSON.stringify(metrics));
  } finally { worker.close(); await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => console.warn("Temporary Electron profile cleanup deferred:", temporary)); }
}

void main().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
