import { randomUUID } from "node:crypto";
import { BrowserWindow } from "electron";

/** Prints app-owned, escaped HTML in a disposable renderer with no scripts or external resources. */
export async function printReportPdf(html: string, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted();
  const window = new BrowserWindow({ show: false, webPreferences: { partition: `excel-print-${randomUUID()}`, sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false } });
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
      (async () => { await window.loadURL(url); deadline.throwIfAborted(); return window.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true }); })(),
      new Promise<never>((_, reject) => {
        abort = () => reject(new Error("PDF 생성이 중단되었거나 30초를 초과했습니다."));
        deadline.addEventListener("abort", abort, { once: true });
        if (deadline.aborted) abort();
      }),
    ]);
  } finally {
    deadline.removeEventListener("abort", abort);
    if (!window.isDestroyed()) window.destroy();
  }
}
