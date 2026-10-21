import { utilityProcess } from "electron";
import type { BusinessTool, ToolResult } from "./contracts.ts";
export type BusinessJob = { toolId: string; version: string; input: Omit<Parameters<BusinessTool["execute"]>[0], "signal"> };
export type BusinessReply = { ok: true; result: ToolResult } | { ok: false; error: string };

/** Killing the worker also stops synchronous workbook/calculation code on cancel or timeout. */
export function executeBusinessJob(workerPath: string, job: BusinessJob, signal: AbortSignal): Promise<ToolResult> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(workerPath, [], { serviceName: "ketchupe-business-tool", stdio: "ignore", execArgv: ["--max-old-space-size=512"] });
    let settled = false;
    const finish = (error?: Error, result?: ToolResult) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort); child.kill();
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => finish(new Error("업무 실행이 중단되었습니다."));
    const timer = setTimeout(() => finish(new Error("업무 실행 시간이 초과되었습니다.")), 120000);
    signal.addEventListener("abort", abort, { once: true });
    child.once("exit", () => finish(new Error("업무 실행 프로세스가 종료되었습니다.")));
    child.once("message", (reply: BusinessReply) => {
      if (!reply || typeof reply.ok !== "boolean") return finish(new Error("잘못된 업무 프로세스 응답입니다."));
      if (reply.ok) finish(undefined, reply.result); else finish(new Error(reply.error));
    });
    child.once("spawn", () => { if (!settled) { try { child.postMessage(job); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); } } });
    if (signal.aborted) abort();
  });
}
