import { SelectiveWorkbook } from "../work/selectiveWorkbook.ts";
import { extractRows, inspectWorkbook, loadWorkbook } from "../work/mapping.ts";
import type { WorkbookJob, WorkbookReply } from "../work/reader.ts";

process.parentPort.once("message", async (event: { data: WorkbookJob }) => {
  let reply: WorkbookReply;
  try {
    const { bytes, fingerprint, action } = event.data;
    const workbook = await (action.kind === "validate" ? SelectiveWorkbook.open(bytes).then((archive) => archive.loadSheet(action.sheet)) : loadWorkbook(bytes)).catch(() => { throw new Error("엑셀을 읽을 수 없습니다. 파일 손상·암호화 여부와 처리 크기 제한을 확인해 주세요."); });
    const result = action.kind !== "extract"
      ? inspectWorkbook(workbook, fingerprint, action.sheet, action.kind === "inspect" ? action.headerRow : undefined)
      : extractRows(workbook, fingerprint, action.mapping);
    reply = { ok: true, result };
  } catch (error) {
    reply = { ok: false, error: error instanceof Error ? error.message : "엑셀 자료를 확인해 주세요." };
  }
  process.parentPort.postMessage(reply);
});
