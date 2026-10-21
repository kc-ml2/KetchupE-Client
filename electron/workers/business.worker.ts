import { businessTools } from "../business/registry.ts";
import type { BusinessJob, BusinessReply } from "../business/workerClient.ts";

process.parentPort.once("message", async (event: { data: BusinessJob }) => {
  let reply: BusinessReply;
  try {
    const job = event.data;
    const tool = businessTools.find((item) => item.id === job.toolId && item.version === job.version);
    if (!tool || tool.unavailableReason) throw new Error(tool?.unavailableReason ?? "설치된 업무 버전이 없습니다.");
    const files = Object.fromEntries(Object.entries(job.input.files).map(([key, list]) => [key, list.map((file) => ({ ...file, bytes: Buffer.from(file.bytes) }))]));
    reply = { ok: true, result: await tool.execute({ ...job.input, files, signal: new AbortController().signal }) };
  } catch (error) { reply = { ok: false, error: error instanceof Error ? error.message : "업무 실행에 실패했습니다." }; }
  process.parentPort.postMessage(reply);
});
