// Bundle with esbuild --platform=node --packages=external --format=cjs, then run with Electron.
// Arguments: output directory, optional SVG files (otherwise use generated charts; no private workbook needed).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { app, BrowserWindow } from "electron";
import sharp from "sharp";
import { chartSvg } from "../electron/excel/chart.ts";
import { fixtureReport } from "../electron/excel/fixtures.ts";
import { captureChartPng, printReportPdf } from "../electron/excel/pdf.ts";
import { reportPageImages } from "../electron/excel/imageExport.ts";
import type { Report } from "../electron/excel/contracts.ts";

app.on("window-all-closed", () => undefined);
app.on("browser-window-created", (_event, window) => {
  window.webContents.on("did-finish-load", () => console.log("Renderer loaded"));
  window.webContents.on("render-process-gone", (_event, details) => console.log("Renderer exited:", details.reason));
});

async function main() {
  const [outputArg, ...files] = process.argv.filter(arg => arg !== "--no-sandbox").slice(2);
  assert(outputArg, "Expected output directory, optionally followed by SVG paths");
  const output = resolve(outputArg), profile = await mkdtemp(join(tmpdir(), "excel-render-smoke-"));
  app.setPath("userData", profile);
  await app.whenReady();
  try {
    await mkdir(output, { recursive: true });
    const rows = Array.from({ length: 10869 }, (_, i) => ({ cells: [i / 12, 100 - i / 120, 1 + Math.sin(i / 250)], sourceRows: [i + 1] }));
    const report: Report = { ...fixtureReport, rowCount: rows.length,
      rowSources: [{ fileId: "file1", sheet: "실험", firstId: 1, row: 2, count: rows.length }],
      result: { tables: [], datasets: [{ title: "Large chart", columns: ["Temperature", "Weight", "Derivative"], rows }], excluded: [], notes: [], chart: null,
        charts: [{ type: "line", dataset: true, table: 0, x: 0, y: 1, xScale: "linear", title: "Large chart", series: [{ y: 1, axis: "left" }, { y: 2, axis: "right" }] }] },
    };
    const cases = files.length ? await Promise.all(files.map(async file => ({ name: basename(file, ".svg"), svg: await readFile(file, "utf8") }))) : [
      { name: "line", svg: chartSvg(report) },
      { name: "scatter", svg: chartSvg({ ...report, result: { ...report.result, charts: [{ ...report.result.charts![0], type: "scatter" }] } }) },
      { name: "line-labels", svg: chartSvg({ ...report, view: { charts: { "0": { labels: true } } } }) },
    ];
    const metrics = [];
    let reproduced = false;
    for (const { name, svg } of cases) {
      const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>body{margin:0}svg{width:100%;height:auto}@page{size:A4 landscape;margin:10mm}</style></head><body>${svg}</body></html>`;
      const oldUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
      if (!reproduced && oldUrl.length > 2 * 1024 * 1024) {
        const old = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false } });
        try {
          await assert.rejects(old.loadURL(oldUrl), /ERR_INVALID_URL/);
          reproduced = true;
          console.log(`Confirmed old data URL fails: ${oldUrl.length} characters`);
        } finally { old.destroy(); }
      }
      const signal = AbortSignal.timeout(180000);
      const start = performance.now();
      console.log(`Rendering PNG: ${name}`);
      const png = await captureChartPng(svg, signal), pngMs = Math.round(performance.now() - start);
      console.log(`PNG rendered: ${name}, ${pngMs}ms`);
      const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const viewBox = svg.match(/viewBox="0 0 (\d+) (\d+)"/)!;
      assert.equal(info.width, 1600);
      assert.equal(info.height, Math.ceil(1600 * Number(viewBox[2]) / Number(viewBox[1])));
      let blue = 0, red = 0;
      for (let i = 0; i < data.length; i += info.channels) {
        const [r, g, b] = data.subarray(i, i + 3);
        if (b > 150 && r < 100 && g < 160) blue++;
        if (r > 150 && g < 100 && b < 100) red++;
      }
      assert(blue > 100 && red > 100, `${name}: both series must be visible, blue=${blue}, red=${red}`);
      console.log(`Rendering PDF: ${name}`);
      const pdfStart = performance.now(), pdf = await printReportPdf(html, signal);
      const pdfMs = Math.round(performance.now() - pdfStart);
      const pages = await reportPageImages(pdf, signal);
      assert(pages.length > 0);
      await writeFile(join(output, `${name}.png`), png);
      await writeFile(join(output, `${name}.pdf`), pdf);
      const measurement = { name, svgBytes: Buffer.byteLength(svg), oldUrlChars: oldUrl.length, pngMs, pdfMs, pngBytes: png.length, pngWidth: info.width, pngHeight: info.height, pdfBytes: pdf.length, pages: pages.length, blue, red };
      metrics.push(measurement);
      console.log(JSON.stringify(measurement));
    }
    assert(reproduced, "At least one chart must exceed the old URL limit");
    await writeFile(join(output, "metrics.json"), JSON.stringify({ platform: process.platform, electron: process.versions.electron, metrics }, null, 2));
  } finally {
    // Windows keeps Chromium's profile database open until Electron exits.
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(error => {
      if (process.platform !== "win32" || !["EBUSY", "EPERM", "ENOTEMPTY"].includes(error.code)) throw error;
      console.warn("Temporary Electron profile cleanup deferred:", profile);
    });
  }
}

void main().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
