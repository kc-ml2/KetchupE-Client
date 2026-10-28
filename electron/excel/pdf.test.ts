// @vitest-environment node
import { expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ create: vi.fn(), destroy: vi.fn(), requestFilter: vi.fn() }));
vi.mock("electron", () => ({ BrowserWindow: class {
  destroyed = false;
  webContents = { session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), webRequest: { onBeforeRequest: mock.requestFilter } }, setWindowOpenHandler: vi.fn(), on: vi.fn(), printToPDF: vi.fn(async () => Buffer.from("%PDF-1.7\n%%EOF")) };
  loadURL = vi.fn(async () => undefined);
  isDestroyed = () => this.destroyed;
  destroy = () => { this.destroyed = true; mock.destroy(); };
  constructor(options: unknown) { mock.create(options); }
} }));
import { printReportPdf } from "./pdf.ts";

it("prints without host privileges and destroys the isolated renderer", async () => {
  await expect(printReportPdf("<html>fixture</html>", new AbortController().signal)).resolves.toBeInstanceOf(Uint8Array);
  expect(mock.create).toHaveBeenLastCalledWith(expect.objectContaining({ show: false, webPreferences: expect.objectContaining({ sandbox: true, javascript: false, nodeIntegration: false }) }));
  const filter = mock.requestFilter.mock.calls[0][0];
  const cb = vi.fn(); filter({ resourceType: "image", url: "https://example.com/image" }, cb);
  expect(cb).toHaveBeenCalledWith({ cancel: true });
  expect(mock.destroy).toHaveBeenCalledOnce();
});

it("rejects pre-cancelled printing without creating a window", async () => {
  const count = mock.create.mock.calls.length;
  const controller = new AbortController(); controller.abort();
  await expect(printReportPdf("test", controller.signal)).rejects.toThrow();
  expect(mock.create).toHaveBeenCalledTimes(count);
});
