import { randomUUID } from "node:crypto";
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
  const window = new BrowserWindow({ show: false, ...(size ?? {}), useContentSize: true, webPreferences: { partition: `excel-print-${randomUUID()}`, sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, backgroundThrottling: false } });
  const session = window.webContents.session;
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.resourceType !== "mainFrame" || details.url !== url }));
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
  let abort: () => void = () => undefined;
  try {
    return await Promise.race([
      (async () => {
        await window.loadURL(url); deadline.throwIfAborted();
        if (!size) return window.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
        // A hidden window's first capture can contain only part of a long SVG path.
        await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
        await new Promise(resolve => setTimeout(resolve, 200));
        deadline.throwIfAborted();
        return (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG();
      })(),
      new Promise<never>((_, reject) => {
        abort = () => reject(new Error("파일 렌더링이 중단되었거나 30초를 초과했습니다."));
        deadline.addEventListener("abort", abort, { once: true });
        if (deadline.aborted) abort();
      }),
    ]);
  } finally {
    deadline.removeEventListener("abort", abort);
    if (!window.isDestroyed()) window.destroy();
  }
}
