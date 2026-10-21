import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AgentStreamEvent, RunAction, StartRunInput } from "../../src/app-types/Agent.types.ts";
import type { ExtractionPreview, WorkSelection } from "../../src/app-types/WorkSource.types.ts";
import type { WorkflowRoute } from "./router.ts";
import type { RunHandle } from "./runLifecycle.ts";
import { appendMessage, createRun, getRun, getRunAction, setRunStatus } from "./store.ts";
import { TraceWriter } from "./trace.ts";

export const WORK_SOURCES_ROUTE: WorkflowRoute = {
  id: "work_sources",
  description: "PC의 엑셀 파일·폴더를 업무 자료로 연결하고 시트·열 매핑과 행 추출을 검증한다. 파일을 지정하거나 추출 규칙을 설정·확인하려는 실행 요청에 사용한다.",
  examples: ["ERP 엑셀을 연결해서 입출금 내역을 확인해줘", "이 폴더의 자료를 참고할 수 있게 설정해줘", "엑셀에서 필요한 항목을 가져오고 싶어"],
  requiredInputs: ["사용자가 지정한 로컬 파일 또는 폴더", "시트와 열의 매핑"],
};
export const DAILY_CASH_ROUTE: WorkflowRoute = {
  id: "daily_cash",
  description: "일일자금일보 작성 요청의 원천 자료 준비·추출 검증을 시작한다. 현재 잔액 대사와 최종 엑셀 출력은 미구현이므로 준비까지만 실행하고 남은 범위를 알린다. 작성 방법 설명은 chat이다.",
  examples: ["일일자금일보 작성해줘", "오늘 자금 현황을 일보로 정리해줘", "어제 입출금으로 자금일보 만들어줘"],
  requiredInputs: ["기준일에 해당하는 원천 파일", "검증된 추출 매핑", "최종 작성에는 담당자와 합의한 대사·출력 규칙 필요"],
};

/** Local input collection shared by registered workflows; no financial data enters a model or telemetry. */
export class WorkSourcesFlow {
  constructor(private readonly db: DatabaseSync, private readonly emit: (event: AgentStreamEvent) => void) {}

  start(input: StartRunInput, kind: "work_sources" | "daily_cash"): RunHandle {
    const runId = createRun(this.db, { threadId: input.threadId, goal: input.text, kind, retrievalProfile: "local", policyProfile: "work-sources-v1", answerProfile: "local" });
    appendMessage(this.db, { threadId: input.threadId, runId, role: "user", content: input.text });
    new TraceWriter(this.db, runId).record("run.started", "runtime", { localOnly: true, workflow: kind });
    this.ask(runId, kind === "daily_cash"
      ? "일일자금일보 자료 준비를 시작합니다. 사용할 원천 파일과 추출 매핑을 지정해 주세요. 현재는 자료 검증까지 지원하며 최종 보고서 계산·출력은 아직 연결되지 않았습니다."
      : "참고할 로컬 파일·폴더와 가져올 항목을 지정해 주세요. 저장된 매핑이 있으면 불러와 검증할 수 있습니다.");
    return { runId, done: Promise.resolve() };
  }

  resume(runId: string, text: string): RunHandle {
    const run = this.ownedRun(runId);
    if (run.status !== "waiting_user") throw new Error("사용자 입력을 기다리는 작업이 아닙니다.");
    if (/^(취소|중단|그만|cancel|stop)[.!\s]*$/i.test(text.trim())) { this.cancel(runId); return { runId, done: Promise.resolve() }; }
    appendMessage(this.db, { threadId: run.threadId, runId, role: "user", content: text });
    this.ask(runId, "자료 선택 화면에서 사용할 파일과 매핑을 확인한 뒤 ‘이 자료로 계속’을 눌러 주세요. 다른 작업을 시작하려면 현재 작업을 중단할 수 있습니다.");
    return { runId, done: Promise.resolve() };
  }

  checkRequest(runId: string, actionId: string): void {
    this.ownedRun(runId);
    if (getRunAction(this.db, runId)?.id !== actionId) throw new Error("이미 처리되었거나 변경된 입력 요청입니다. 현재 대화에서 다시 확인해 주세요.");
  }

  complete(runId: string, actionId: string, selection: WorkSelection, preview: ExtractionPreview): void {
    this.checkRequest(runId, actionId);
    if (preview.issueCount || !preview.matchedRows) throw new Error("검증된 대상 행이 필요합니다.");
    const run = this.ownedRun(runId);
    const daily = run.kind === "daily_cash";
    const text = `선택한 자료에서 ${preview.scannedRows}행을 검사해 ${preview.matchedRows}행을 추출 대상으로 확인했습니다. 조건 제외 ${preview.excludedRows}행, 빈 행 ${preview.blankRows}개, 추출 오류 ${preview.issueCount}건입니다.\n\n${daily
      ? "일일자금일보 원천 자료 준비를 마쳤습니다. 잔액 대사·금융상품·환율 규칙과 고정 양식 출력을 아직 연결하지 않아 최종 보고서는 생성하지 않았습니다."
      : "자료와 매핑 검증을 마쳤습니다. 원본 파일은 수정하지 않았습니다."}`;
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE run_actions SET selection = ? WHERE run_id = ?").run(JSON.stringify(selection), runId);
      setRunStatus(this.db, runId, daily ? "abstained" : "completed");
      appendMessage(this.db, { threadId: run.threadId, runId, role: "assistant", content: text });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    this.event(runId, "completed", { text, outcome: daily ? "abstained" : "success" }, "run.completed");
  }

  cancel(runId: string): void {
    const run = this.ownedRun(runId);
    if (run.status !== "waiting_user" && run.status !== "running") return;
    setRunStatus(this.db, runId, "cancelled", "CANCELLED");
    this.event(runId, "failed", { code: "CANCELLED", message: "작업을 중단했습니다." }, "run.failed");
  }

  private ownedRun(runId: string) {
    const run = getRun(this.db, runId);
    if (run.kind !== "work_sources" && run.kind !== "daily_cash") throw new Error("업무 자료 입력을 받는 작업이 아닙니다.");
    return run;
  }

  private ask(runId: string, question: string): void {
    const run = this.ownedRun(runId);
    const action: RunAction = { id: randomUUID(), type: "work_sources", title: "업무 자료 선택", question };
    this.db.prepare("INSERT INTO run_actions (run_id, action) VALUES (?, ?) ON CONFLICT(run_id) DO UPDATE SET action = excluded.action, selection = NULL").run(runId, JSON.stringify(action));
    setRunStatus(this.db, runId, "waiting_user");
    appendMessage(this.db, { threadId: run.threadId, runId, role: "assistant", content: question });
    this.event(runId, "ask_user", { question, action }, "run.waiting_user");
  }

  private event(runId: string, type: AgentStreamEvent["type"], payload: unknown, traceType: "run.waiting_user" | "run.completed" | "run.failed") {
    const seq = new TraceWriter(this.db, runId).record(traceType, "runtime", { localOnly: true });
    this.emit({ runId, seq, type, payload });
  }
}
