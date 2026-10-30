import { utilityProcess } from "electron";
import type { UtilityProcess } from "electron";
import type { Analysis, AnalysisPlan, ProfileInspection, Report, WorkbookInput, WorkbookProfile } from "./contracts.ts";

export type ExcelJob = { kind: "profile"; bytes: Uint8Array; query?: string; inspection?: ProfileInspection } | { kind: "analyze"; files: WorkbookInput[]; plan: AnalysisPlan } | { kind: "export"; report: Report; format: "html" | "xlsx" };
export type ExcelReply = { ok: true; result: WorkbookProfile | Analysis | Uint8Array } | { ok: false; error: string };
type JobResult<J extends ExcelJob> = J extends { kind: "profile" } ? WorkbookProfile : J extends { kind: "analyze" } ? Analysis : Uint8Array;

/** One utility process reused by sequential jobs so the worker's parsed-workbook cache survives inspect/analyze turns. Abort or timeout kills it; the next job respawns. */
export function createExcelWorker(workerPath: string) {
  let child: UtilityProcess | undefined, ready: Promise<void> | undefined, busy = false;
  const close = () => { child?.kill(); child = undefined; ready = undefined; };
  const run = <J extends ExcelJob>(job: J, signal: AbortSignal): Promise<JobResult<J>> => {
    signal.throwIfAborted();
    if (busy) return Promise.reject(new Error("엑셀 작업이 이미 실행 중입니다."));
    busy = true;
    if (!child) {
      const process = child = utilityProcess.fork(workerPath, [], { serviceName: "ketchupe-excel", stdio: "ignore" });
      ready = new Promise(resolve => process.once("spawn", resolve));
      process.once("exit", () => { if (child === process) { child = undefined; ready = undefined; } });
    }
    const process = child;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, result?: unknown, healthy = false) => {
        if (settled) return;
        settled = true; busy = false; clearTimeout(timer); signal.removeEventListener("abort", abort);
        process.off("message", message); process.off("exit", exit);
        if (error && !healthy) { if (child === process) close(); else process.kill(); }
        if (error) reject(error); else resolve(result as JobResult<J>);
      };
      const abort = () => finish(new Error("엑셀 작업을 중단했습니다."));
      const exit = () => finish(new Error("엑셀 작업 프로세스가 종료되었습니다."));
      const message = (reply: ExcelReply) => {
        if (!reply || typeof reply.ok !== "boolean") finish(new Error("잘못된 엑셀 작업 응답입니다."));
        else if (reply.ok) finish(undefined, reply.result);
        // A job error leaves the worker healthy; keep it and its cache for the next turn.
        else finish(new Error(reply.error), undefined, true);
      };
      const timer = setTimeout(() => finish(new Error("엑셀 작업이 30초를 초과했습니다. 데이터 범위를 줄여 주세요.")), 30000);
      signal.addEventListener("abort", abort, { once: true });
      process.on("exit", exit);
      process.on("message", message);
      void ready!.then(() => {
        if (settled) return;
        try { process.postMessage(job); } catch { finish(new Error("엑셀 작업을 시작하지 못했습니다.")); }
      });
      if (signal.aborted) abort();
    });
  };
  return { run, close };
}
export type ExcelWorker = ReturnType<typeof createExcelWorker>;

export async function executeExcelJob<J extends ExcelJob>(workerPath: string, job: J, signal: AbortSignal): Promise<JobResult<J>> {
  const worker = createExcelWorker(workerPath);
  try { return await worker.run(job, signal); } finally { worker.close(); }
}
