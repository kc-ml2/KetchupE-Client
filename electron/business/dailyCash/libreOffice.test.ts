// @vitest-environment node
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock("node:child_process", () => mocks);
import { exportWithLibreOffice, libreOfficeExecutable } from "./libreOffice.ts";

let directory = "";
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetAllMocks(); vi.useRealTimers();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  directory = await mkdtemp(join(tmpdir(), "lo-test-"));
  const executable = join(directory, "soffice");
  await writeFile(executable, "fixture", { mode: 0o700 });
  vi.stubEnv("KETCHUPE_LIBREOFFICE_PATH", executable);
  const input = join(directory, '한글 "$name.xlsx'), sheet = '한글 " target';
  const book = new ExcelJS.Workbook();
  book.addWorksheet(sheet).pageSetup.printArea = "A1:A3";
  const original = Buffer.from(await book.xlsx.writeBuffer());
  await writeFile(input, original);
  return { executable, input, pdf: join(directory, "report.pdf"), sheet, original };
}

it.each(["calculate", "pdf"] as const)("uses an isolated profile and passes untrusted names as data (%s)", async (operation) => {
  const { executable, input, pdf, sheet, original } = await fixture();
  let profile = "";
  const errors: unknown[] = [];
  mocks.spawn.mockImplementation((_file, args, options) => {
    const child = Object.assign(new EventEmitter(), { stderr: new PassThrough(), kill: vi.fn() });
    setImmediate(async () => {
      try {
        profile = fileURLToPath(args[0].slice("-env:UserInstallation=".length));
        if (!args.includes("--terminate_after_init")) {
          expect(options.env).toMatchObject({ KETCHUPE_LO_INPUT: input, KETCHUPE_LO_SHEET: sheet, KETCHUPE_LO_OPERATION: operation });
          const script = await readFile(join(profile, "user/basic/Standard/KetchupE.xba"), "utf8");
          expect(script).not.toContain(sheet);
          expect(script).toContain('"MacroExecutionMode" : args(1).Value = 0');
          expect(script).toContain('"UpdateDocMode" : args(2).Value = 0');
          expect(script).toContain('filters(0).Name = "Selection"');
          await writeFile(options.env.KETCHUPE_LO_OUTPUT, "exported");
        }
      } catch (error) { errors.push(error); }
      child.emit("close", 0);
    });
    return child;
  });
  expect(await libreOfficeExecutable()).toBe(executable);
  await exportWithLibreOffice(input, sheet, pdf, new AbortController().signal, operation);
  expect(errors).toEqual([]);
  expect(mocks.spawn).toHaveBeenCalledTimes(2);
  expect(await readFile(operation === "calculate" ? input : pdf, "utf8")).toBe("exported");
  if (operation === "pdf") expect(await readFile(input)).toEqual(original);
  await expect(access(profile)).rejects.toThrow();
});

it("reports native script errors and removes the private profile", async () => {
  const { input, pdf, sheet } = await fixture();
  mocks.spawn.mockImplementation((_file, args, options) => {
    const child = Object.assign(new EventEmitter(), { stderr: new PassThrough(), kill: vi.fn() });
    setImmediate(async () => {
      if (!args.includes("--terminate_after_init")) await writeFile(options.env.KETCHUPE_LO_ERROR, "PDF export failed");
      child.emit("close", 0);
    });
    return child;
  });
  await expect(exportWithLibreOffice(input, sheet, pdf, new AbortController().signal, "pdf")).rejects.toThrow("PDF export failed");
  expect((await readdir(directory)).some(name => name.startsWith("libreoffice-"))).toBe(false);
});

it.each(["darwin", "win32"])("stops only the owned process tree on %s cancellation and cleans the profile", async (os) => {
  Object.defineProperty(process, "platform", { value: os });
  const { input, pdf, sheet } = await fixture();
  const abort = new AbortController();
  const child = Object.assign(new EventEmitter(), { pid: 123456, stderr: new PassThrough(), kill: vi.fn() });
  const kill = vi.spyOn(process, "kill").mockImplementation(() => { setImmediate(() => child.emit("close", null)); return true; });
  mocks.execFile.mockImplementation((_file, _args, _options, callback) => { callback(null, "", ""); setImmediate(() => child.emit("close", null)); });
  mocks.spawn.mockImplementation(() => { setImmediate(() => abort.abort(new Error("cancelled"))); return child; });
  await expect(exportWithLibreOffice(input, sheet, pdf, abort.signal, "calculate")).rejects.toThrow("cancelled");
  if (os === "darwin") expect(kill).toHaveBeenCalledWith(-123456, "SIGKILL");
  else {
    expect(kill).not.toHaveBeenCalled();
    expect(mocks.execFile.mock.calls[0][1]).toEqual(["/PID", "123456", "/T", "/F"]);
  }
  expect((await readdir(directory)).some(name => name.startsWith("libreoffice-"))).toBe(false);
});
