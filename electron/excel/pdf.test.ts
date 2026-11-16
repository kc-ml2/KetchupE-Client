// @vitest-environment node
import { readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ create: vi.fn(), destroy: vi.fn(), requestFilter: vi.fn(), load: vi.fn<(url: string) => Promise<void>>(), capture: vi.fn(async () => ({ toPNG: () => Buffer.from("png") })) }));
vi.mock("electron", () => ({ BrowserWindow: class {
  destroyed = false;
  webContents = { capturePage: mock.capture, session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), webRequest: { onBeforeRequest: mock.requestFilter } }, setWindowOpenHandler: vi.fn(), on: vi.fn(), printToPDF: vi.fn(async () => Buffer.from("%PDF-1.7\n%%EOF")) };
  loadURL = mock.load;
  isDestroyed = () => this.destroyed;
  destroy = () => { this.destroyed = true; mock.destroy(); };
  constructor(options: unknown) { mock.create(options); }
} }));
import sharp from "sharp";
import { captureChartPng, printReportPdf } from "./pdf.ts";

beforeEach(() => { vi.clearAllMocks(); mock.load.mockReset().mockResolvedValue(undefined); });

it("prints without host privileges and destroys the isolated renderer", async () => {
  await expect(printReportPdf("<html>fixture</html>", new AbortController().signal)).resolves.toBeInstanceOf(Uint8Array);
  expect(mock.create).toHaveBeenLastCalledWith(expect.objectContaining({ show: false, webPreferences: expect.objectContaining({ sandbox: true, javascript: false, nodeIntegration: false }) }));
  const filter = mock.requestFilter.mock.calls[0][0];
  const cb = vi.fn(); filter({ resourceType: "image", url: "https://example.com/image" }, cb);
  expect(cb).toHaveBeenCalledWith({ cancel: true });
  const url = mock.load.mock.calls[0][0];
  filter({ resourceType: "mainFrame", url }, cb);
  expect(cb).toHaveBeenLastCalledWith({ cancel: false });
  for (const request of [{ resourceType: "subFrame", url }, { resourceType: "image", url }, { resourceType: "mainFrame", url: "file:///other.html" }, { resourceType: "mainFrame", url: "https://example.com" }]) {
    filter(request, cb);
    expect(cb).toHaveBeenLastCalledWith({ cancel: true });
  }
  await expect(stat(dirname(fileURLToPath(url)))).rejects.toMatchObject({ code: "ENOENT" });
  expect(mock.destroy).toHaveBeenCalledOnce();
});

it("loads large HTML unchanged from a private file instead of a data URL", async () => {
  const html = `<html>${"측정값 & < >".repeat(300000)}</html>`;
  expect(encodeURIComponent(html).length).toBeGreaterThan(2 * 1024 * 1024);
  mock.load.mockImplementationOnce(async url => {
    expect(url.startsWith("file:")).toBe(true);
    expect(url.length).toBeLessThan(2048);
    const file = fileURLToPath(url);
    expect(await readFile(file, "utf8")).toBe(html);
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(file))).mode & 0o777).toBe(0o700);
    }
  });
  await printReportPdf(html, new AbortController().signal);
  await expect(stat(fileURLToPath(mock.load.mock.calls[0][0]))).rejects.toMatchObject({ code: "ENOENT" });
});

it("removes temporary HTML and destroys the window after a load failure", async () => {
  mock.load.mockRejectedValueOnce(new Error("load failed"));
  await expect(printReportPdf("report", new AbortController().signal)).rejects.toThrow("load failed");
  expect(mock.destroy).toHaveBeenCalledOnce();
  await expect(stat(dirname(fileURLToPath(mock.load.mock.calls[0][0])))).rejects.toMatchObject({ code: "ENOENT" });
});

it("cancels a stalled load and cleans up its private file", async () => {
  const controller = new AbortController();
  mock.load.mockImplementationOnce(async () => { controller.abort(); return new Promise(() => undefined); });
  await expect(printReportPdf("report", controller.signal)).rejects.toThrow("중단");
  expect(mock.destroy).toHaveBeenCalledOnce();
  await expect(stat(dirname(fileURLToPath(mock.load.mock.calls[0][0])))).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps concurrent reports in separate temporary files", async () => {
  const loaded: string[] = [];
  mock.load.mockImplementation(async url => { loaded.push(await readFile(fileURLToPath(url), "utf8")); });
  await Promise.all(["first", "second"].map(html => printReportPdf(html, new AbortController().signal)));
  expect(loaded.sort()).toEqual(["first", "second"]);
  expect(new Set(mock.load.mock.calls.map(([url]) => url)).size).toBe(2);
  for (const [url] of mock.load.mock.calls) await expect(stat(dirname(fileURLToPath(url)))).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects pre-cancelled printing without creating a window", async () => {
  const count = mock.create.mock.calls.length;
  const controller = new AbortController(); controller.abort();
  await expect(printReportPdf("test", controller.signal)).rejects.toThrow();
  expect(mock.create).toHaveBeenCalledTimes(count);
});

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="500" viewBox="0 0 960 500"><rect x="240" y="125" width="480" height="250" fill="#ff0000"/></svg>';

it("rasterizes PNG at exact size with colors and white background without creating a window", async () => {
  const png = await captureChartPng(svg, new AbortController().signal);
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  expect([info.width, info.height]).toEqual([1600, 834]);
  expect([...data.subarray(0, 3)]).toEqual([255, 255, 255]);
  const center = (417 * info.width + 800) * info.channels;
  expect([...data.subarray(center, center + 3)]).toEqual([255, 0, 0]);
  expect(mock.create).not.toHaveBeenCalled();
  expect(mock.capture).not.toHaveBeenCalled();
});

it("rejects invalid or oversized SVG dimensions and malformed SVG", async () => {
  for (const box of ["", 'viewBox="0 0 0 500"', 'viewBox="0 0 960 0"']) {
    await expect(captureChartPng(`<svg ${box}></svg>`, new AbortController().signal)).rejects.toThrow("크기");
  }
  await expect(captureChartPng('<svg viewBox="0 0 1 9000"></svg>', new AbortController().signal)).rejects.toThrow("너무 큽니다");
  await expect(captureChartPng('<svg viewBox="0 0 960 500">', new AbortController().signal)).rejects.toThrow();
  expect(mock.create).not.toHaveBeenCalled();
});

it("rejects cancelled PNG rendering before and during conversion", async () => {
  const controller = new AbortController(); controller.abort();
  await expect(captureChartPng(svg, controller.signal)).rejects.toThrow();
  const active = new AbortController();
  const pending = captureChartPng(svg, active.signal);
  active.abort();
  await expect(pending).rejects.toThrow("중단");
  expect(mock.create).not.toHaveBeenCalled();
});

it("bounds PNG rendering time even while native work is queued", async () => {
  vi.useFakeTimers();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  });
  const buffer = vi.spyOn(sharp.prototype, "toBuffer").mockImplementation(() => new Promise(() => undefined));
  try {
    const pending = expect(captureChartPng(svg, new AbortController().signal)).rejects.toThrow("60초");
    await vi.advanceTimersByTimeAsync(60000);
    await pending;
  } finally {
    buffer.mockRestore(); timeout.mockRestore(); vi.useRealTimers();
  }
});
