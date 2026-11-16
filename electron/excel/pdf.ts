import { EXCEL_LIMITS } from "./limits.ts";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserWindow } from "electron";

/** Prints app-owned, escaped HTML in a disposable renderer with no scripts or external resources. */
export async function printReportPdf(html: string, signal: AbortSignal): Promise<Uint8Array> {
  return renderReportPage(html, signal);
}

export async function captureChartPng(svg: string, signal: AbortSignal): Promise<Uint8Array> {
  const size = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
  if (!size) throw new Error("차트 크기를 확인할 수 없습니다.");
  const width = 1600, height = Math.ceil(width * Number(size[2]) / Number(size[1]));
  if (height > 4000) throw new Error("차트 이미지가 너무 큽니다.");
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'"><style>body{margin:0;background:white}svg{display:block;width:100%;height:auto}</style></head><body>${svg}</body></html>`;
  return renderReportPage(html, signal, { width, height });
}

async function renderReportPage(html: string, signal: AbortSignal, size?: { width: number; height: number }): Promise<Uint8Array> {
  signal.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "ketchupe-excel-render-"));
  let window: BrowserWindow | undefined;
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(EXCEL_LIMITS.workerMs)]);
  let abort: () => void = () => undefined;
  try {
    // Large SVGs exceed Chromium's URL limit when embedded in a data: URL.
    const file = join(directory, "report.html"), url = pathToFileURL(file).href;
    await writeFile(file, html, { mode: 0o600 });
    deadline.throwIfAborted();
    const renderer = window = new BrowserWindow({ show: false, ...(size ?? {}), useContentSize: true, webPreferences: { partition: `excel-print-${randomUUID()}`, sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, backgroundThrottling: false } });
    const session = renderer.webContents.session;
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
    session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.resourceType !== "mainFrame" || details.url !== url }));
    renderer.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    renderer.webContents.on("will-navigate", (event) => event.preventDefault());
    return await Promise.race([
      (async () => {
        await renderer.loadURL(url); deadline.throwIfAborted();
        if (!size) return renderer.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
        // A hidden window's first capture can contain only part of a long SVG path.
        await renderer.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
        await new Promise(resolve => setTimeout(resolve, 200));
        deadline.throwIfAborted();
        return (await renderer.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG();
      })(),
      new Promise<never>((_, reject) => {
        abort = () => reject(new Error("파일 렌더링이 중단되었거나 60초를 초과했습니다."));
        deadline.addEventListener("abort", abort, { once: true });
        if (deadline.aborted) abort();
      }),
    ]);
  } finally {
    deadline.removeEventListener("abort", abort);
    if (window && !window.isDestroyed()) window.destroy();
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
