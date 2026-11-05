import { utilityProcess } from "electron";
import type { BusinessTool, ToolResult } from "./contracts.ts";
export type BusinessJob = { toolId: string; version: string; input: Omit<Parameters<BusinessTool["execute"]>[0], "signal" | "onProgress"> };
export type BusinessReply = { ok: true; result: ToolResult } | { ok: false; error: string };
let macDailyCashBusy = false;

/** Native Excel gets time to close its temporary workbook after cancellation. */
export function executeBusinessJob(workerPath: string, job: BusinessJob, signal: AbortSignal): Promise<ToolResult> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const exclusive = process.platform === "darwin" && job.toolId === "daily_cash";
    if (exclusive && macDailyCashBusy) return reject(new Error("다른 일일자금일보 작업이 실행 또는 정리 중입니다. 완료 후 다시 실행하세요."));
    const child = utilityProcess.fork(workerPath, [], { serviceName: "ketchupe-business-tool", stdio: "ignore", execArgv: ["--max-old-space-size=1024"] });
    if (exclusive) macDailyCashBusy = true;
    let settled = false, started = false, stopped = false;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const release = () => { if (exclusive) macDailyCashBusy = false; };
    const stop = () => { clearTimeout(cleanupTimer); if (!stopped) { stopped = true; release(); child.kill(); } };
    const finish = (error?: Error, result?: ToolResult, cancel = false) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (cancel && started && job.toolId === "daily_cash") {
        try { child.postMessage({ cancel: true }); cleanupTimer = setTimeout(stop, 110000); cleanupTimer.unref(); } catch { stop(); }
      } else stop();
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => finish(new Error("업무 실행이 중단되었습니다."), undefined, true);
    const timer = setTimeout(() => finish(new Error("업무 실행 시간이 초과되었습니다."), undefined, true), job.toolId === "daily_cash" ? 480000 : 120000);
    signal.addEventListener("abort", abort, { once: true });
    child.once("exit", () => { clearTimeout(cleanupTimer); if (!stopped) { stopped = true; release(); } finish(new Error("업무 실행 프로세스가 종료되었습니다.")); });
    child.once("message", (reply: BusinessReply) => {
      if (settled) return stop();
      if (!reply || typeof reply.ok !== "boolean") return finish(new Error("잘못된 업무 프로세스 응답입니다."));
      if (reply.ok) finish(undefined, reply.result); else finish(new Error(reply.error));
    });
    child.once("spawn", () => { if (!settled) { try { started = true; child.postMessage(job); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); } } });
    if (signal.aborted) abort();
  });
}
