import type { DatabaseSync } from "node:sqlite";
import type { AgentStreamEvent, StartRunInput, StartRunResult } from "../../src/app-types/Agent.types.ts";
import { AgentError } from "./contracts.ts";
import { selectRoutingContext } from "./context.ts";
import { routeMessage, type RoutingContext, type WorkflowRoute } from "./router.ts";
import type { ModelSettings } from "./settings.ts";
import { appendMessage, createRun, findOpenRun, getRun, getRunAction, getThread, setRunStatus } from "./store.ts";
import { readTrace, TraceWriter } from "./trace.ts";
import { WorkflowHandoff, type AgentWorkflow, type WorkflowStartInput } from "./workflows.ts";

const MAX_HANDOFFS = 2;
type Router = (text: string, routes: readonly WorkflowRoute[], signal: AbortSignal, context: RoutingContext) => Promise<string>;

export type HarnessOptions = {
  db: DatabaseSync;
  workflows: readonly AgentWorkflow[];
  routingSettings: () => ModelSettings;
  authorizeThread?: (threadId: string, signal: AbortSignal) => Promise<void>;
  emit?: (event: AgentStreamEvent) => void;
  onSettled?: (runId: string) => void;
  route?: Router;
};

/** Owns the entire request, from routing to bounded handoffs; Runtime only supplies dependencies. */
export class Harness {
  private readonly byId = new Map<string, AgentWorkflow>();
  private readonly byKind = new Map<string, AgentWorkflow>();
  private readonly controls = new Map<string, AbortController>();
  private readonly tasks = new Map<string, Promise<void>>();
  private readonly switching = new Set<string>();
  private readonly seqs = new Map<string, number>();
  private stopped = false;

  constructor(private readonly options: HarnessOptions) {
    for (const workflow of options.workflows) {
      if (!workflow.id || ["auto", "routing"].includes(workflow.id) || !workflow.kind || workflow.kind === "routing" || this.byId.has(workflow.id) || this.byKind.has(workflow.kind)) {
        throw new Error(`duplicate or invalid workflow: ${workflow.id}/${workflow.kind}`);
      }
      this.byId.set(workflow.id, workflow);
      this.byKind.set(workflow.kind, workflow);
    }
    if (!this.byId.size) throw new Error("at least one workflow is required");
  }

  routes(): WorkflowRoute[] {
    return [...this.byId.values()].map(({ id, description, examples, requiredInputs }) => ({ id, description, examples, requiredInputs }));
  }

  start(input: WorkflowStartInput): StartRunResult {
    if (this.stopped) throw new AgentError("CANCELLED", "signed out");
    const { db } = this.options;
    const thread = getThread(db, input.threadId);
    if (thread.workspaceId !== input.workspaceId) throw new AgentError("INTERNAL", "대화의 작업 공간이 일치하지 않습니다.");
    if (!input.text.trim()) throw new AgentError("INTERNAL", "요청 내용을 입력하세요.");
    const open = findOpenRun(db, thread.id);
    if (open) {
      this.resume(open.id, input.text);
      return this.result(open.id);
    }
    const explicit = this.explicitMode(input);
    if (explicit) this.workflow(explicit);
    const runId = createRun(db, { threadId: thread.id, goal: input.text.trim(), kind: "routing", retrievalProfile: "pending", policyProfile: "harness-1", answerProfile: "pending" });
    appendMessage(db, { threadId: thread.id, runId, role: "user", content: input.text.trim() });
    new TraceWriter(db, runId).record("request.started", "input", { workspaceId: input.workspaceId, threadId: thread.id });
    const controller = new AbortController();
    this.controls.set(runId, controller);
    // Return a cancellable run ID before any network work or executor events reach the renderer.
    this.track(runId, controller, async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await this.options.authorizeThread?.(thread.id, controller.signal);
      controller.signal.throwIfAborted();
      const id = explicit ?? await this.choose(runId, input.text, controller.signal);
      await this.execute(runId, id, input.canvas, controller.signal);
    });
    return { runId, kind: "routing", status: "running" };
  }

  resume(runId: string, text: string): void {
    this.assertAvailable(runId);
    const run = getRun(this.options.db, runId);
    if (run.status !== "waiting_user") throw new AgentError("INTERNAL", "사용자 응답을 기다리는 작업이 아닙니다.");
    const workflow = this.owner(run.kind);
    if (!workflow.resume) throw new AgentError("INTERNAL", "이 작업은 전용 화면에서 이어서 진행하세요.");
    if (!text.trim()) throw new AgentError("INTERNAL", "응답 내용을 입력하세요.");
    const controller = new AbortController();
    const handle = workflow.resume(runId, text);
    this.controls.set(runId, controller);
    this.track(runId, controller, async () => {
      try { await handle.done; }
      catch (error) {
        if (!(error instanceof WorkflowHandoff)) throw error;
        controller.signal.throwIfAborted();
        this.checkHandoff(runId, error.workflow);
        await this.execute(runId, error.workflow, undefined, controller.signal, error.reason);
      }
    });
  }

  /** A user correction can replace any running/waiting executor, including one restored after restart. */
  async switchWorkflow(runId: string, text: string, mode?: string): Promise<void> {
    this.assertAvailable(runId);
    if (!text.trim()) throw new AgentError("INTERNAL", "변경할 작업 내용을 입력하세요.");
    const run = getRun(this.options.db, runId);
    if (!["running", "waiting_user"].includes(run.status) || run.kind === "routing") throw new AgentError("INTERNAL", "실행 중이거나 입력을 기다리는 작업만 변경할 수 있습니다.");
    if (readTrace(this.options.db, runId).some((event) => event.type === "workflow.effect_started")) throw new AgentError("INTERNAL", "원본 파일 갱신이 시작된 작업은 변경할 수 없습니다. 완료 후 새 요청으로 시작해 주세요.");
    const explicit = this.explicitMode({ text, mode });
    if (explicit) this.checkHandoff(runId, explicit);
    if (this.selections(runId).length > MAX_HANDOFFS) throw new AgentError("BUDGET_EXCEEDED", "작업 전환 횟수를 초과했습니다. 새 요청으로 시작해 주세요.");
    if (!readTrace(this.options.db, runId).some((event) => event.type === "workflow.selected")) {
      new TraceWriter(this.options.db, runId).record("workflow.selected", "runtime", { workflow: this.owner(run.kind).id, kind: run.kind, reason: "restored" });
    }
    const oldTask = this.tasks.get(runId);
    this.controls.get(runId)?.abort();
    const controller = new AbortController();
    this.controls.set(runId, controller);
    this.switching.add(runId);
    const task = this.track(runId, controller, async () => {
      try {
        await this.owner(run.kind).cancel(runId);
        await oldTask;
        controller.signal.throwIfAborted();
        setRunStatus(this.options.db, runId, "running");
        this.options.db.prepare("DELETE FROM run_actions WHERE run_id = ?").run(runId);
        appendMessage(this.options.db, { threadId: run.threadId, runId, role: "user", content: text.trim() });
        const goal = `${run.goal}\n\n사용자 정정: ${text.trim()}`;
        this.options.db.prepare("UPDATE runs SET goal = ? WHERE id = ?").run(goal, runId);
        this.send(runId, "status", { phase: "routing", messagesChanged: true });
        await this.options.authorizeThread?.(run.threadId, controller.signal);
        controller.signal.throwIfAborted();
        const id = explicit ?? await this.choose(runId, text, controller.signal, { currentWorkflow: this.owner(run.kind).id, originalGoal: run.goal });
        this.checkHandoff(runId, id);
        this.switching.delete(runId);
        await this.execute(runId, id, undefined, controller.signal, "user_correction");
      } finally { this.switching.delete(runId); }
    });
    // Execution continues in the background, just like start/resume; routing failures are stream events.
    void task;
  }

  async cancel(runId: string): Promise<void> {
    const run = getRun(this.options.db, runId);
    if (!["running", "waiting_user"].includes(run.status) && !this.switching.has(runId)) return;
    this.controls.get(runId)?.abort();
    if (run.kind !== "routing" && !this.switching.has(runId)) await this.owner(run.kind).cancel(runId);
    if (getRun(this.options.db, runId).status !== "cancelled") {
      setRunStatus(this.options.db, runId, "cancelled", "CANCELLED");
      new TraceWriter(this.options.db, runId).record("run.failed", "runtime", { code: "CANCELLED" });
      this.send(runId, "failed", { code: "CANCELLED", message: "작업을 중단했습니다." });
    } else if (this.switching.has(runId)) {
      this.send(runId, "failed", { code: "CANCELLED", message: "작업을 중단했습니다." });
    }
  }

  assertAvailable(runId: string): void {
    if (this.stopped) throw new AgentError("CANCELLED", "signed out");
    if (this.switching.has(runId) || getRun(this.options.db, runId).kind === "routing") throw new AgentError("INTERNAL", "작업을 선택하거나 전환하는 중입니다.");
  }

  /** All executors share one monotonic renderer stream across workflow changes. */
  forward(event: AgentStreamEvent): void {
    if (this.switching.has(event.runId)) return;
    this.send(event.runId, event.type, event.payload);
  }

  async drain(runId: string): Promise<void> { await this.tasks.get(runId); }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.controls.keys()].map((id) => this.cancel(id)));
    await Promise.allSettled([...this.tasks.values()]);
  }

  private explicitMode(input: Pick<StartRunInput, "text" | "mode">): string | undefined {
    return input.mode && input.mode !== "auto" ? input.mode : input.text.trim().match(/^\$([a-zA-Z][a-zA-Z0-9_-]*)(?=\s|$)/)?.[1];
  }

  private workflow(id: string): AgentWorkflow {
    const workflow = this.byId.get(id);
    if (!workflow) throw new AgentError("INTERNAL", `등록되지 않은 기능입니다: ${id}`);
    return workflow;
  }

  private owner(kind: string): AgentWorkflow {
    const workflow = this.byKind.get(kind);
    if (!workflow) throw new AgentError("INTERNAL", `unregistered workflow kind: ${kind}`);
    return workflow;
  }

  private result(runId: string): StartRunResult {
    const run = getRun(this.options.db, runId);
    const action = getRunAction(this.options.db, runId);
    return { runId, kind: run.kind, status: run.status, ...(action ? { action } : {}) };
  }

  private selections(runId: string): string[] {
    const selections = readTrace(this.options.db, runId).filter((event) => event.type === "workflow.selected").map((event) => String(event.payload.workflow));
    if (!selections.length) {
      const owner = this.byKind.get(getRun(this.options.db, runId).kind);
      if (owner) selections.push(owner.id);
    }
    return selections;
  }

  private checkHandoff(runId: string, id: string): void {
    this.workflow(id);
    if (readTrace(this.options.db, runId).some((event) => event.type === "workflow.effect_started")) throw new AgentError("INTERNAL", "원본 파일 갱신이 시작된 작업은 전환할 수 없습니다.");
    const visited = this.selections(runId);
    if (visited.includes(id)) throw new AgentError("INVALID_DECISION", "이미 선택했던 작업으로 다시 전환할 수 없습니다. 새 요청으로 시작해 주세요.");
    if (visited.length > MAX_HANDOFFS) throw new AgentError("BUDGET_EXCEEDED", "작업 전환 횟수를 초과했습니다. 새 요청으로 시작해 주세요.");
  }

  private async choose(runId: string, text: string, signal: AbortSignal, correction?: Pick<RoutingContext, "currentWorkflow" | "originalGoal">): Promise<string> {
    const run = getRun(this.options.db, runId);
    const trace = new TraceWriter(this.options.db, runId);
    const startedAt = Date.now();
    const modelAlias = this.options.routingSettings().modelAlias;
    const parentSeq = trace.record("model.started", "policy", { purpose: "routing", modelAlias });
    this.send(runId, "status", { phase: "routing" });
    let choice: string | undefined;
    let code: string | undefined;
    try {
      const context = { ...selectRoutingContext(this.options.db, run.threadId), ...correction };
      choice = await (this.options.route ?? ((message, routes, requestSignal, routingContext) => routeMessage(this.options.routingSettings(), message, requestSignal, routes, routingContext)))(text, this.routes(), signal, context);
      signal.throwIfAborted();
      this.workflow(choice);
      return choice;
    } catch (error) {
      code = error instanceof AgentError ? error.code : signal.aborted ? "CANCELLED" : "INTERNAL";
      throw error;
    } finally {
      trace.record("model.completed", "policy", { purpose: "routing", modelAlias, latencyMs: Date.now() - startedAt, workflow: choice, ...(code ? { code } : {}) }, { parentSeq, startedAt });
    }
  }

  private async execute(runId: string, initialId: string, canvas: WorkflowStartInput["canvas"], signal: AbortSignal, reason?: string): Promise<void> {
    let id = initialId;
    while (true) {
      signal.throwIfAborted();
      const workflow = this.workflow(id);
      const run = getRun(this.options.db, runId);
      if (run.status !== "running") return;
      this.options.db.prepare("DELETE FROM run_actions WHERE run_id = ?").run(runId);
      new TraceWriter(this.options.db, runId).record("workflow.selected", "runtime", { workflow: id, kind: workflow.kind, reason });
      this.send(runId, "workflow_changed", { threadId: run.threadId, kind: workflow.kind, workflow: id, reason });
      const handle = workflow.start({ runId, threadId: run.threadId, workspaceId: getThread(this.options.db, run.threadId).workspaceId, text: run.goal, mode: id, canvas });
      if (handle.runId !== runId) throw new AgentError("INTERNAL", "Workflow did not adopt its request");
      try { await handle.done; return; }
      catch (error) {
        if (!(error instanceof WorkflowHandoff)) throw error;
        signal.throwIfAborted();
        this.checkHandoff(runId, error.workflow);
        id = error.workflow;
        reason = error.reason;
        canvas = undefined;
      }
    }
  }

  private track(runId: string, controller: AbortController, work: () => Promise<void>): Promise<void> {
    const task = work().catch((error: unknown) => {
      if (this.controls.get(runId) !== controller) return;
      const run = getRun(this.options.db, runId);
      if (!["running", "waiting_user"].includes(run.status)) return;
      const failure = controller.signal.aborted ? new AgentError("CANCELLED", "작업을 중단했습니다.") : error instanceof AgentError ? error : new AgentError("INTERNAL", "작업을 진행하지 못했습니다. 다시 요청해 주세요.");
      setRunStatus(this.options.db, runId, failure.code === "CANCELLED" ? "cancelled" : "failed", failure.code);
      new TraceWriter(this.options.db, runId).record("run.failed", "runtime", { code: failure.code, message: failure.message });
      this.send(runId, "failed", { code: failure.code, message: failure.message });
    }).finally(() => {
      if (this.controls.get(runId) === controller) this.controls.delete(runId);
      if (this.tasks.get(runId) === task) this.tasks.delete(runId);
    });
    this.tasks.set(runId, task);
    return task;
  }

  private send(runId: string, type: AgentStreamEvent["type"], payload: unknown): void {
    const seq = (this.seqs.get(runId) ?? 0) + 1;
    this.seqs.set(runId, seq);
    this.options.emit?.({ runId, seq, type, payload });
    if (["ask_user", "completed", "failed"].includes(type)) {
      try { this.options.onSettled?.(runId); }
      catch { console.warn("[harness] telemetry export failed"); }
    }
  }
}
