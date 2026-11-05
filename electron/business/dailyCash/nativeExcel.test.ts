// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: mock.execute }));
vi.mock("node:fs/promises", () => ({ access: vi.fn(async () => {}) }));
import { exportWithExcel } from "./nativeExcel.ts";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => { mock.execute.mockReset().mockImplementation((_file, _args, _options, callback) => callback(null, "", "")); });
afterEach(() => { Object.defineProperty(process, "platform", platform); });

it.each([["darwin", "calculate"], ["darwin", "pdf"], ["win32", "calculate"], ["win32", "pdf"]] as const)("passes paths and sheet names as data on %s (%s)", async (os, operation) => {
  Object.defineProperty(process, "platform", { value: os });
  const input = '/tmp/한글 " quote $name.xlsx', name = "a'; throw evil", pdf = "/tmp/한글.pdf";
  await exportWithExcel(input, name, pdf, new AbortController().signal, operation);
  const [executable, args, options] = mock.execute.mock.calls[0];
  expect(options.shell).toBeUndefined();
  if (os === "darwin") {
    expect(executable).toBe("/usr/bin/osascript");
    expect(args.slice(-5)).toEqual([input, name, pdf, operation, ""]);
    expect(args[1]).not.toContain(name);
  } else {
    const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
    expect(script).not.toContain(name);
    expect(options.env.KETCHUPE_EXCEL_SHEET).toBe(name);
    expect(options.env.KETCHUPE_EXCEL_INPUT).toBe(input);
    expect(options.env.KETCHUPE_EXCEL_OPERATION).toBe(operation);
  }
});

it("reports native failures without dumping script source", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  mock.execute.mockImplementation((_file, _args, _options, callback) => callback(Object.assign(new Error("script source"), { stderr: "permission denied" }), "", "permission denied"));
  await expect(exportWithExcel("in", "sheet", "out", new AbortController().signal, "calculate")).rejects.toThrow("permission denied");
});

it("runs Windows ownership-checked cleanup even when native export times out", async () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  mock.execute.mockImplementationOnce((_file, _args, _options, callback) => callback(new Error("timeout")));
  await expect(exportWithExcel("in", "sheet", "out", new AbortController().signal, "calculate")).rejects.toThrow("timeout");
  expect(mock.execute).toHaveBeenCalledTimes(2);
  const [, args, options] = mock.execute.mock.calls[1];
  const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
  expect(script).toContain("$process.StartTime.ToFileTimeUtc().ToString() -eq $owner.started");
  expect(options.env.KETCHUPE_EXCEL_PROCESS).toBe("in.process");
});

it("does not start on an aborted signal and discards an export cancelled during execution", async () => {
  const abort = new AbortController(); abort.abort(new Error("cancelled"));
  await expect(exportWithExcel("in", "sheet", "out", abort.signal, "calculate")).rejects.toThrow("cancelled");
  expect(mock.execute).not.toHaveBeenCalled();
  Object.defineProperty(process, "platform", { value: "darwin" });
  const during = new AbortController();
  mock.execute.mockImplementation((_file, _args, _options, callback) => { during.abort(new Error("cancelled")); callback(null, "", ""); });
  await expect(exportWithExcel("in", "sheet", "out", during.signal, "calculate")).rejects.toThrow("cancelled");
});
