import { utilityProcess } from "electron";
import type { ExtractionPreview, SourceMapping, WorkbookOverview } from "../../src/app-types/WorkSource.types.ts";

export type WorkbookJob = {
  bytes: Uint8Array; fingerprint: string;
  action: { kind: "inspect"; sheet?: string; headerRow?: number } | { kind: "extract"; mapping: SourceMapping };
};
export type WorkbookReply = { ok: true; result: WorkbookOverview | ExtractionPreview } | { ok: false; error: string };

/** One bounded process per read. Parsing cannot block the app or outlive its timeout. */
export function readWorkbookJob(workerPath: string, job: WorkbookJob): Promise<WorkbookOverview | ExtractionPreview> {
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(workerPath, [], { serviceName: "ketchupe-workbook", stdio: "ignore", execArgv: ["--max-old-space-size=256"] });
    let settled = false;
    const finish = (error?: Error, result?: WorkbookOverview | ExtractionPreview) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error); else resolve(result!);
    };
    const timer = setTimeout(() => finish(new Error("엑셀 읽기 시간이 초과되었습니다. 더 작은 파일로 나누어 주세요.")), 30000);
    child.once("exit", () => finish(new Error("엑셀 읽기 프로세스가 종료되었습니다. 파일 크기와 형식을 확인해 주세요.")));
    child.once("message", (reply: WorkbookReply) => reply.ok ? finish(undefined, reply.result) : finish(new Error(reply.error)));
    child.once("spawn", () => child.postMessage(job));
  });
}
