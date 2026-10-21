import type { DatabaseSync } from "node:sqlite";
import type { StartRunInput, StartRunResult } from "../../src/app-types/Agent.types.ts";
import { AgentError } from "./contracts.ts";
import type { WorkflowRoute } from "./router.ts";
import { findOpenRun, getRun, getThread } from "./store.ts";
import type { RunHandle } from "./runLifecycle.ts";
import { getRunAction } from "./store.ts";

export type WorkflowHandle = RunHandle;

/** Each workflow owns its policy, state, tools and persisted resume payload. */
export type AgentWorkflow = WorkflowRoute & {
  kind: string;
  start: (input: StartRunInput) => WorkflowHandle;
  resume?: (runId: string, text: string) => WorkflowHandle;
  cancel: (runId: string) => void;
};

export class WorkflowDispatcher {
  private readonly byId = new Map<string, AgentWorkflow>();
  private readonly byKind = new Map<string, AgentWorkflow>();
  private readonly starting = new Set<string>();

  constructor(
    private readonly db: DatabaseSync,
    workflows: readonly AgentWorkflow[],
    private readonly route: (text: string, routes: readonly WorkflowRoute[], input: StartRunInput) => Promise<string>,
    private readonly onStarted?: (runId: string) => void,
  ) {
    for (const workflow of workflows) {
      if (!workflow.id || workflow.id === "auto" || !workflow.kind || this.byId.has(workflow.id) || this.byKind.has(workflow.kind)) {
        throw new Error(`duplicate or invalid workflow: ${workflow.id}/${workflow.kind}`);
      }
      this.byId.set(workflow.id, workflow);
      this.byKind.set(workflow.kind, workflow);
    }
    if (!workflows.length) throw new Error("at least one workflow is required");
  }

  async start(input: StartRunInput): Promise<StartRunResult> {
    const thread = getThread(this.db, input.threadId);
    if (thread.workspaceId !== input.workspaceId) throw new AgentError("INTERNAL", "대화의 작업 공간이 일치하지 않습니다.");
    if (!input.text.trim()) throw new AgentError("INTERNAL", "요청 내용을 입력하세요.");
    if (this.starting.has(thread.id)) throw new AgentError("INTERNAL", "이 대화에 진행 중인 작업이 있습니다.");
    this.starting.add(thread.id);
    try {
      const open = findOpenRun(this.db, thread.id);
      if (open) {
        const handle = this.resume(open.id, input.text);
        const action = getRunAction(this.db, handle.runId);
        return { runId: handle.runId, kind: open.kind, ...(action ? { action } : {}) };
      }
      const id = input.mode && input.mode !== "auto"
        ? input.mode
        : await this.route(input.text, [...this.byId.values()], input);
      const workflow = this.byId.get(id);
      if (!workflow) throw new AgentError("INTERNAL", `unknown workflow: ${id}`);
      // Routing awaits a model call; another entry point may have started a run meanwhile.
      if (findOpenRun(this.db, thread.id)) throw new AgentError("INTERNAL", "이 대화에 진행 중인 작업이 있습니다.");
      const handle = workflow.start(input);
      this.onStarted?.(handle.runId);
      const action = getRunAction(this.db, handle.runId);
      return { runId: handle.runId, kind: workflow.kind, ...(action ? { action } : {}), ...(getRun(this.db, handle.runId).status === "abstained" ? { status: "abstained" as const } : {}) };
    } finally {
      this.starting.delete(thread.id);
    }
  }

  resume(runId: string, text: string): WorkflowHandle {
    const run = getRun(this.db, runId);
    const workflow = this.owner(run.kind);
    if (run.status !== "waiting_user") throw new AgentError("INTERNAL", "사용자 응답을 기다리는 작업이 아닙니다.");
    if (!workflow.resume) throw new AgentError("INTERNAL", "이 작업은 전용 화면에서 이어서 진행하세요.");
    if (!text.trim()) throw new AgentError("INTERNAL", "응답 내용을 입력하세요.");
    return workflow.resume(runId, text);
  }

  cancel(runId: string): void {
    const run = getRun(this.db, runId);
    if (run.status === "running" || run.status === "waiting_user") this.owner(run.kind).cancel(runId);
  }

  private owner(kind: string): AgentWorkflow {
    const workflow = this.byKind.get(kind);
    if (!workflow) throw new AgentError("INTERNAL", `unregistered workflow kind: ${kind}`);
    return workflow;
  }
}
