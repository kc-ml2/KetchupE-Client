// @vitest-environment node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { windowsCleanupScript } from "./nativeExcel.ts";

// Run real Windows PowerShell in CI; no Office installation or financial files are needed.
it.skipIf(process.platform !== "win32")("accepts an already exited Excel and leaves other processes alone", async () => {
  const directory = await mkdtemp(join(tmpdir(), "excel-cleanup-"));
  const owner = join(directory, "export.process");
  const execute = promisify(execFile);
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    // The child is already gone when cleanup reads its recorded process ID.
    const child = execFile(process.execPath, ["-e", ""], () => {});
    const exitedId = child.pid!;
    await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", () => resolve()); });
    for (const id of [exitedId, process.pid]) {
      await writeFile(owner, JSON.stringify({ id, started: "0" }));
      await expect(execute(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(windowsCleanupScript, "utf16le").toString("base64")], {
        timeout: 10000, windowsHide: true, env: { ...process.env, KETCHUPE_EXCEL_PROCESS: owner },
      })).resolves.toMatchObject({ stderr: "" });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30000);
