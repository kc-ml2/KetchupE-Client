import { analysisPlan } from "../excel/contracts.ts";
import { profileWorkbook, readAnalysisInputs } from "../excel/workbook.ts";
import { runAnalysis } from "../excel/sandbox.ts";
import { renderHtml, renderXlsx } from "../excel/render.ts";
import type { ExcelJob, ExcelReply } from "../excel/workerClient.ts";

process.parentPort.on("message", async (event: { data: ExcelJob }) => {
  let reply: ExcelReply;
  try {
    const job = event.data;
    if (job.kind === "profile") reply = { ok: true, result: await profileWorkbook(job.bytes, job.query, job.inspection) };
    else if (job.kind === "analyze") {
      const plan = analysisPlan.parse(job.plan);
      const { rows, blankRows, sourceNotes, rowSources } = await readAnalysisInputs(job.files, plan);
      reply = { ok: true, result: { result: await runAnalysis(plan.code, rows), rowCount: rows.length, blankRows, sourceNotes, rowSources } };
    } else if (job.kind === "export") reply = { ok: true, result: job.format === "xlsx" ? await renderXlsx(job.report) : Buffer.from(renderHtml(job.report)) };
    else throw new Error("지원하지 않는 엑셀 작업입니다.");
  } catch (error) { reply = { ok: false, error: error instanceof Error ? error.message.slice(0, 3000) : "엑셀 작업에 실패했습니다." }; }
  process.parentPort.postMessage(reply);
});
