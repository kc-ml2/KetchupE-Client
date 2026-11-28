import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AgentStreamEvent } from "../../src/app-types/Agent.types.ts";
import type { BusinessAction, BusinessArtifact, BusinessField, BusinessInput } from "../../src/app-types/BusinessTool.types.ts";
import type { WorkFile } from "../../src/app-types/WorkSource.types.ts";
import { REVISE_REQUEST_TEXT } from "../../src/app-types/BusinessTool.types.ts";
import { appendMessage, getRun, getRunAction, setRunStatus } from "../agent/store.ts";
import { TraceWriter } from "../agent/trace.ts";
import { startWorkflowRun } from "../agent/runLifecycle.ts";
import type { AgentWorkflow, WorkflowStartInput } from "../agent/workflows.ts";
import { WorkSources } from "../work/sources.ts";
import { businessInputSchema, businessTraceSchema, type BusinessTool, type Recovery } from "./contracts.ts";
import { applyPatch, parseDecision, PatchError, TURN_SYSTEM, turnPrompt } from "./agentTurn.ts";

/** `confirmed` flips on the first accepted submission; until then every prefilled value (suggested files, today's date) stays editable. */
type Job = { toolId: string; version: string; input: BusinessInput; fingerprints: Record<string, string[]>; fields: BusinessField[]; checkpoint?: Record<string, unknown>; pendingKeys?: string[]; confirmed?: boolean; baseArtifactId?: string; revision?: number;
  /** Where and why the tool last stopped, and the last failure: the state a chat turn explains and the trace records. */
  stop?: { step?: string; code?: string }; lastError?: { message: string; recovery?: Recovery; step?: string } };
/** A chat-driven submission: the user's message is already in the thread, `echo` states what was applied. */
type ChatSubmission = { echo: string };
const RECOVERY_GUIDE: Record<Recovery, string> = {
  fix_input: "입력한 내용은 보관되어 있습니다. 해당 입력을 고친 뒤 다시 실행할 수 있습니다.",
  retry: "입력한 내용은 보관되어 있습니다. 같은 입력으로 다시 실행할 수 있습니다.",
  environment: "입력한 내용은 보관되어 있습니다. 위 메시지의 실행 환경을 확인한 뒤 같은 입력으로 다시 실행해 주세요.",
  new_run: "원천 파일이나 작업일을 바꿔야 해결됩니다. 지금까지의 입력과 진행 상태는 이 작업에 보관되어 있습니다. 이 작업을 중단하고 새 작업으로 시작해 주세요.",
};
const emptyInput = (): BusinessInput => ({ values: {}, files: {} });
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fieldKey = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const sameFile = (a: WorkFile, b: WorkFile) => a.sourceId === b.sourceId && a.relativePath === b.relativePath;
/** The chat bubble for a conversational reply: what the user typed plus the names of files they attached. */
const describeReply = (text: string, files: WorkFile[]) => [text.trim(), files.length ? `첨부: ${files.map(file => file.name).join(", ")}` : ""].filter(Boolean).join("\n");
/** A quick-reply chip sends the option label; typed text may also name the value. */
const matchOption = (field: BusinessField, text: string) => {
  const wanted = text.trim().toLowerCase();
  return field.options?.find(option => option.value.toLowerCase() === wanted || option.label.toLowerCase() === wanted)?.value;
};
export const ASK_FILES = "이 작업에 사용할 엑셀 파일을 입력창의 📎 버튼으로 첨부해 주세요. 여러 파일을 함께 붙여도 됩니다.";
export const ASK_REQUEST = "어떤 작업을 할까요? 원하는 결과를 편하게 적어 주세요. 예: 실험일별 인장강도를 정리해 HTML로 만들어줘";

export class BusinessFlow {
  private readonly tools = new Map<string, BusinessTool>();
  private readonly pending = new Set<Promise<void>>();
  private readonly submissions = new Map<string, Promise<void>>();
  private readonly active = new Map<string, AbortController>();
  private readonly turns = new Map<string, AbortController>();
  constructor(private readonly db: DatabaseSync, tools: BusinessTool[], private readonly outputDir: string,
    private readonly emit: (event: AgentStreamEvent) => void,
    private readonly validateWorkbook: (bytes: Uint8Array, sheet?: string) => Promise<void>,
    private readonly timeoutMs = 120000,
    /** Interprets chat messages sent to a waiting tool. Without it, fixed-input tools keep pointing at the input card. */
    private readonly converse?: (system: string, prompt: string, signal: AbortSignal) => Promise<string>) {
    for (const tool of tools) {
      if (this.tools.has(tool.id)) throw new Error("duplicate business tool");
      this.validateFields(tool.fields);
      this.tools.set(tool.id, tool);
    }
  }

  workflows(): AgentWorkflow[] {
    return [...this.tools.values()].map((tool) => ({ ...tool, kind: tool.id,
      start: (input) => this.start(tool, input), resume: (id, text, files) => this.resume(id, text, files), cancel: async (id) => { this.cancel(id); await this.drain(id); },
    }));
  }

  private start(tool: BusinessTool, input: WorkflowStartInput) {
    const { runId } = startWorkflowRun(this.db, { threadId: input.threadId, goal: input.text, kind: tool.id, retrievalProfile: "local", policyProfile: `${tool.id}@${tool.version}`, answerProfile: "deterministic" }, input.runId);
    new TraceWriter(this.db, runId).record("run.started", "runtime", { localOnly: true, toolId: tool.id, version: tool.version });
    let initial = emptyInput(), checkpoint: Record<string, unknown> | undefined;
    let fingerprints: Job["fingerprints"] = {}, baseArtifactId: string | undefined;
    if (tool.editable) {
      if (input.baseArtifactId && !/^[a-f0-9-]{36}$/.test(input.baseArtifactId)) throw new Error("잘못된 수정 대상입니다.");
      const previous = this.db.prepare("SELECT j.payload, a.id FROM business_jobs j JOIN runs r ON r.id=j.run_id JOIN business_artifacts a ON a.run_id=r.id WHERE r.thread_id=? AND r.kind=? AND r.status='completed' AND (? IS NULL OR a.id=?) ORDER BY r.created_at DESC, r.rowid DESC, a.rowid LIMIT 1").get(input.threadId, tool.id, input.baseArtifactId ?? null, input.baseArtifactId ?? null);
      if (input.baseArtifactId && !previous) throw new Error("이 대화에서 완료한 결과만 수정할 수 있습니다.");
      if (previous) {
        const job = JSON.parse(String(previous.payload)) as Job;
        fingerprints = job.fingerprints; baseArtifactId = String(previous.id);
        initial = { files: job.input.files, values: { request: job.input.values.request, format: job.input.values.format ?? "", revision: input.text === REVISE_REQUEST_TEXT ? "" : input.text } };
        checkpoint = job.checkpoint ? { excelState: job.checkpoint.excelState, clarifications: job.checkpoint.clarifications } : undefined;
      // A launcher button sends its own label ("엑셀 작업하기"); that is not a request, so the chat asks for one.
      } else if (!tool.title.startsWith(input.text.trim())) initial.values.request = input.text;
    }
    if (tool.defaults) initial.values = { ...initial.values, ...tool.defaults(new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" })) };
    this.save(runId, { toolId: tool.id, version: tool.version, input: initial, fingerprints, fields: tool.fields, checkpoint, baseArtifactId });
    if (tool.unavailableReason) { this.finish(runId, tool.unavailableReason, "abstained"); return { runId, done: Promise.resolve() }; }
    this.ask(runId, baseArtifactId ? "선택한 결과의 기준을 유지합니다. 바꾸고 싶은 내용을 입력해 주세요." : tool.editable && initial.values.request ? ASK_FILES : tool.initialQuestion ?? "기준 정보와 원천 파일을 지정해 주세요.");
    if (tool.editable && initial.files.source?.length && input.text !== REVISE_REQUEST_TEXT) return { runId, done: this.submit(runId, getRunAction(this.db, runId)!.id, initial, input.text) };
    return { runId, done: Promise.resolve() };
  }

  private resume(runId: string, text: string, files: WorkFile[] = []) {
    const job = this.job(runId);
    if (getRun(this.db, runId).status !== "waiting_user") throw new Error("입력 대기 중인 작업이 아닙니다.");
    if (!files.length && /^(취소|중단|그만|cancel|stop)[.!\s]*$/i.test(text.trim())) this.cancel(runId);
    else if (this.tools.get(job.toolId)?.editable) return { runId, done: this.fillFromChat(runId, job, text, files) };
    else if (this.converse && text.trim()) return { runId, done: this.turn(runId, text.trim()) };
    else {
      appendMessage(this.db, { threadId: getRun(this.db, runId).threadId, runId, role: "user", content: text });
      this.ask(runId, "입력 화면에서 확인 내용을 작성해 주세요. 확인되지 않은 대화 내용을 계산 입력으로 사용하지 않습니다.");
    }
    return { runId, done: Promise.resolve() };
  }

  /**
   * Conversational input for editable tools: the chat reply (and any attached files) fills the same fields the input card used to,
   * so the tool contract and validation stay unchanged. Attachments add to the source files; text fills, in order, the missing
   * request, extra detail before the first run, the pending question, or a revision of the finished result.
   */
  private fillFromChat(runId: string, job: Job, text: string, files: WorkFile[]): Promise<void> {
    const input = structuredClone(job.input);
    const hadSource = Boolean(input.files.source?.length);
    if (files.length) input.files.source = [...(input.files.source ?? []), ...files].filter((file, index, list) => list.findIndex(item => sameFile(item, file)) === index);
    const reply = text.trim();
    const pending = job.fields.find(field => job.pendingKeys?.includes(field.key) && (field.type === "text" || field.type === "select"));
    const display = describeReply(text, files);
    const wait = (question: string) => {
      job.input = input; this.save(runId, job);
      appendMessage(this.db, { threadId: getRun(this.db, runId).threadId, runId, role: "user", content: display });
      this.ask(runId, question);
      return Promise.resolve();
    };
    if (reply) {
      if (!input.values.request?.trim()) input.values.request = reply;
      else if (!hadSource) input.values.request = `${input.values.request}\n${reply}`.slice(0, 4000);
      else if (pending?.type === "select") {
        const value = matchOption(pending, reply);
        if (!value) return wait(`다음 중에서 골라 주세요: ${pending.options?.map(option => option.label).join(", ")}`);
        input.values[pending.key] = value;
      } else if (pending) input.values[pending.key] = reply;
      else input.values.revision = [input.values.revision, reply].filter(Boolean).join("\n").slice(-4000);
    }
    if (!input.values.request?.trim()) return wait(ASK_REQUEST);
    if (!input.files.source?.length) return wait(ASK_FILES);
    return this.submit(runId, getRunAction(this.db, runId)!.id, input, reply || undefined, display);
  }

  submit(runId: string, actionId: string, raw: unknown, userText?: string, display?: string): Promise<void> {
    if (this.submissions.has(runId)) return Promise.reject(new Error("이미 처리 중인 입력 요청입니다."));
    const task = this.executeSubmission(runId, actionId, raw, userText, display);
    this.pending.add(task);
    this.submissions.set(runId, task);
    void task.finally(() => { this.pending.delete(task); if (this.submissions.get(runId) === task) this.submissions.delete(runId); }).catch(() => undefined);
    return task;
  }

  /**
   * One chat message to a waiting fixed-input tool: the model proposes a single decision, code decides what it may touch.
   * A reply keeps the same action (and the card's draft); an input change goes through the same submission path as the card.
   */
  private turn(runId: string, text: string): Promise<void> {
    if (this.submissions.has(runId)) return Promise.reject(new Error("이미 처리 중인 입력 요청입니다."));
    const task = this.runTurn(runId, text);
    this.pending.add(task);
    this.submissions.set(runId, task);
    void task.finally(() => { this.pending.delete(task); if (this.submissions.get(runId) === task) this.submissions.delete(runId); }).catch(() => undefined);
    return task;
  }

  private async runTurn(runId: string, text: string): Promise<void> {
    const job = this.job(runId), tool = this.tools.get(job.toolId), action = getRunAction(this.db, runId);
    if (!tool || !action) throw new Error("입력 대기 중인 작업이 아닙니다.");
    const controller = new AbortController();
    this.turns.set(runId, controller);
    const started = Date.now();
    let decision = "error";
    const current = () => getRun(this.db, runId).status === "waiting_user" && getRunAction(this.db, runId)?.id === action.id;
    appendMessage(this.db, { threadId: getRun(this.db, runId).threadId, runId, role: "user", content: text });
    try {
      const editable = this.chatKeys(job, tool);
      let raw: string;
      try {
        raw = await this.abortable(this.converse!(TURN_SYSTEM, turnPrompt({ title: tool.title, step: job.stop?.step, code: job.stop?.code, question: action.question, lastError: job.lastError?.message,
          fields: job.fields, editable, pending: new Set(job.pendingKeys ?? job.fields.map((field) => field.key)), values: job.input.values,
          fileNames: Object.fromEntries(Object.entries(job.input.files).map(([key, list]) => [key, list.map((file) => file.name)])), userText: text }), controller.signal), controller.signal);
      } finally { this.turns.delete(runId); }
      // The run may have been cancelled, switched or answered through the card while the model was thinking.
      if (!current()) return;
      const parsed = parseDecision(raw);
      decision = parsed.kind;
      if (parsed.kind === "reply") this.say(runId, parsed.message);
      else if (parsed.kind === "cancel") this.cancel(runId);
      else if (parsed.kind === "switch") this.say(runId, "이 작업을 그만두고 다른 작업으로 바꾸려면 입력창의 **작업 변경**을 사용해 주세요. 지금까지 입력한 내용은 그대로 있습니다.");
      else {
        const values = parsed.kind === "retry" ? job.input.values : applyPatch(job.fields, job.input.values, parsed.patch, editable);
        const changed = Object.keys(values).filter((key) => values[key] !== job.input.values[key]);
        if (parsed.kind === "set_inputs" && !changed.length) { decision = "no_change"; this.say(runId, "바꿀 내용을 찾지 못했습니다. 어떤 항목을 어떻게 바꿀지 다시 말씀해 주시거나 입력 카드에서 직접 고쳐 주세요."); return; }
        const input = { values, files: job.input.files };
        await this.executeSubmission(runId, action.id, input, text, undefined, { echo: changed.length ? `다음 내용을 반영해 다시 확인합니다.\n${this.describeInput(job, input, changed)}` : "같은 입력으로 다시 실행합니다." });
      }
    } catch (error) {
      if (controller.signal.aborted || !current()) return;
      // A rejected patch or input is explained in its own words; a model failure never loses the card or the answers.
      decision = error instanceof PatchError ? "rejected" : decision;
      this.say(runId, error instanceof PatchError || decision !== "error" ? `${error instanceof Error ? error.message : String(error)}\n\n입력한 내용은 그대로 있습니다. 입력 카드에서 직접 고칠 수도 있습니다.` : "메시지를 처리하지 못했습니다. 입력한 내용은 그대로 있습니다. 입력 카드에서 계속하거나 다시 말씀해 주세요.");
    } finally {
      this.turns.delete(runId);
      new TraceWriter(this.db, runId).record("model.completed", "runtime", { localOnly: true, phase: "model", operation: "converse", decision, step: job.stop?.step, code: job.stop?.code }, { startedAt: started });
    }
  }

  /** Fields a chat message may set: never files, never person-only approvals, never the fixed base inputs, and a confirmation only while it is being asked. */
  private chatKeys(job: Job, tool: BusinessTool): Set<string> {
    const pending = new Set(job.pendingKeys ?? job.fields.map((field) => field.key));
    return new Set(job.fields.filter((field) => field.type !== "file" && !field.manualOnly && !(job.confirmed && tool.fields.some((base) => base.key === field.key)) && (field.confirm === undefined || pending.has(field.key))).map((field) => field.key));
  }

  /** Adds an assistant message without replacing the pending action, so the input card and its unsaved draft stay as they are. */
  private say(runId: string, message: string) {
    appendMessage(this.db, { threadId: getRun(this.db, runId).threadId, runId, role: "assistant", content: message });
    this.event(runId, "ask_user", { question: message, action: getRunAction(this.db, runId) });
  }

  private async executeSubmission(runId: string, actionId: string, raw: unknown, userText?: string, display?: string, chat?: ChatSubmission): Promise<void> {
    const job = this.job(runId);
    const tool = this.tools.get(job.toolId);
    if (!tool || tool.version !== job.version) throw new Error("업무 버전이 변경되었습니다. 현재 작업을 중단하고 새로 요청해 주세요.");
    if (getRunAction(this.db, runId)?.id !== actionId || this.active.has(runId)) throw new Error("이미 처리되었거나 변경된 입력 요청입니다.");
    const input = businessInputSchema.parse(raw);
    const changedKeys = Object.keys(input.values).filter(key => input.values[key] !== job.input.values[key]);
    const sourceChanged = JSON.stringify(input.files) !== JSON.stringify(job.input.files);
    const requestChanged = input.values.request !== job.input.values.request;
    const revised = tool.editable && (sourceChanged || requestChanged || input.values.revision !== job.input.values.revision || input.values.format !== job.input.values.format || changedKeys.some(key => /^answer\d+$/.test(key)));
    if (revised) {
      if (sourceChanged || requestChanged) {
        job.checkpoint = {};
        job.fields = tool.fields;
        for (const key of Object.keys(input.values)) if (!tool.fields.some(field => field.key === key)) delete input.values[key];
      } else if (job.checkpoint?.report) {
        job.checkpoint = { ...job.checkpoint };
        delete job.checkpoint.report;
      }
      job.pendingKeys = [];
    }
    // A chat answer may be partial or revise an earlier answer: the tool re-validates everything and asks again for what is missing.
    this.validateInput(revised || chat ? job.fields.map(field => tool.fields.some(base => base.key === field.key) ? field : { ...field, required: false }) : job.fields, input);
    if (!tool.editable && (job.confirmed && Object.entries(job.input.values).some(([key, value]) => value && input.values[key] !== value && (tool.fields.some((field) => field.key === key) || (!chat && !job.pendingKeys?.includes(key)))) || Object.keys(job.fingerprints).some((key) => JSON.stringify(input.files[key]) !== JSON.stringify(job.input.files[key])))) throw new Error("확정된 원천 자료나 기준 정보는 변경할 수 없습니다. 새 작업으로 요청해 주세요.");
    const controller = new AbortController();
    this.active.set(runId, controller);
    const timeout = setTimeout(() => controller.abort(new Error("업무 실행 시간이 초과되었습니다.")), tool.executionTimeoutMs ?? this.timeoutMs);
    appendMessage(this.db, { threadId: getRun(this.db, runId).threadId, runId, ...(chat ? { role: "assistant" as const, content: chat.echo } : { role: "user" as const, content: display ?? this.describeInput(job, input) }) });
    setRunStatus(this.db, runId, "running");
    if (tool.editable) this.db.prepare("DELETE FROM run_actions WHERE run_id=?").run(runId);
    this.event(runId, "status", { phase: "원천 자료 확인 및 업무 실행 중", messagesChanged: true });
    try {
      const filesStarted = Date.now();
      const files: Parameters<BusinessTool["execute"]>[0]["files"] = {};
      const sources = new WorkSources(this.db);
      let totalBytes = 0;
      for (const [key, list] of Object.entries(input.files)) {
        files[key] = [];
        for (const file of list) {
          const value = await sources.read(file);
          totalBytes += value.bytes.length;
          if (totalBytes > 100 * 1024 * 1024) throw new Error("원천 자료 합계는 100MB 이하여야 합니다.");
          files[key].push({ ...value, name: file.name.normalize("NFC") });
        }
        const fingerprints = files[key].map((value) => value.fingerprint);
        if (new Set(fingerprints).size !== fingerprints.length) throw new Error("같은 파일이 두 번 지정되었습니다. 중복 파일을 빼고 다시 실행해 주세요.");
        if (tool.editable) {
          for (let index = 0; index < list.length; index++) {
            const oldIndex = (job.input.files[key] ?? []).findIndex(old => old.sourceId === list[index].sourceId && old.relativePath === list[index].relativePath);
            if (oldIndex >= 0 && job.fingerprints[key]?.[oldIndex] && job.fingerprints[key][oldIndex] !== fingerprints[index]) throw new Error("원천 파일 내용이 변경되었습니다. 최신 파일로 새 작업을 시작해 주세요.");
          }
        } else if (job.fingerprints[key] && (JSON.stringify(job.fingerprints[key]) !== JSON.stringify(fingerprints) || JSON.stringify(job.input.files[key]) !== JSON.stringify(list))) throw new Error("원천 파일이 변경되었습니다. 새 작업으로 다시 실행해 주세요.");
      }
      controller.signal.throwIfAborted();
      job.input = input; job.confirmed = true;
      job.fingerprints = Object.fromEntries(Object.entries(files).map(([key, list]) => [key, list.map((value) => value.fingerprint)]));
      this.save(runId, job);
      new TraceWriter(this.db, runId).record("tool.completed", "runtime", { localOnly: true, phase: "files" }, { startedAt: filesStarted });
      const executeStarted = Date.now();
      const result = await this.abortable(tool.execute({ values: input.values, files, checkpoint: job.checkpoint ?? {}, signal: controller.signal, changedKeys,
        userText: userText ?? changedKeys.filter(key => key === "revision" || key === "revisionAnswer" || /^answer\d+$/.test(key)).map(key => input.values[key]).join("\n"),
        onTrace: (event) => {
          if (controller.signal.aborted) return;
          const safe = businessTraceSchema.parse(event);
          new TraceWriter(this.db, runId).record(safe.phase === "model" ? "model.completed" : "tool.completed", "runtime", { ...safe, localOnly: true }, { startedAt: Date.now() - safe.durationMs });
        }, onProgress: (phase) => {
        if (!controller.signal.aborted && getRun(this.db, runId).status === "running") this.event(runId, "status", { phase });
      } }), controller.signal);
      controller.signal.throwIfAborted();
      // One record per execution: where it stopped, why, and how long each step took. IDs and timings only, no amounts.
      new TraceWriter(this.db, runId).record("tool.completed", "runtime", { localOnly: true, phase: "execute", outcome: result.status, step: result.step, code: result.code, steps: result.trace, ...(result.status === "failed" ? { recovery: result.recovery } : {}) }, { startedAt: executeStarted });
      job.stop = { step: result.step, code: result.code };
      job.lastError = result.status === "failed" ? { message: result.message, recovery: result.recovery, step: result.step } : undefined;
      if (Object.values(input.files).flat().some((file) => !sources.has(file.sourceId))) throw new Error("실행 중 자료 연결이 해제되었습니다.");
      if (result.status === "needs_input") {
        this.validateFields(result.fields);
        const merged = new Map((result.replaceFields ? tool.fields : job.fields).map((field) => [field.key, field]));
        for (const field of result.fields) {
          if (merged.has(field.key) && merged.get(field.key)!.type !== field.type) throw new Error("추가 입력 항목의 형식이 변경되었습니다.");
          merged.set(field.key, field);
        }
        job.fields = [...merged.values()]; this.validateFields(job.fields);
        if (result.replaceFields) job.input.values = Object.fromEntries(Object.entries(job.input.values).filter(([key]) => merged.has(key)));
        job.pendingKeys = result.fields.map((field) => field.key);
        job.checkpoint = result.checkpoint ?? job.checkpoint;
        if (JSON.stringify(job.checkpoint ?? {}).length > 1000000) throw new Error("업무 중간 상태가 너무 큽니다.");
        this.save(runId, job); this.ask(runId, result.question);
      } else if (result.status === "failed") { this.save(runId, job); this.retry(runId, result.message, result.code, result.recovery); }
      else if (result.status === "completed") {
        if (!result.checks.length || result.checks.some((check) => check.passed !== true)) throw new Error("업무 검증을 통과하지 못했습니다.");
        const outputs = [result.file, ...(result.additionalFiles ?? [])];
        if (outputs.length > 14 || new Set(outputs.map(file => file.name)).size !== outputs.length || outputs.reduce((size, file) => size + file.bytes.length, 0) > 60 * 1024 * 1024) throw new Error("출력 파일 수·이름·크기를 확인하세요.");
        if (result.checkpoint && JSON.stringify(result.checkpoint).length > 1000000) throw new Error("업무 중간 상태가 너무 큽니다.");
        for (const file of outputs) {
          if (!/^[^/\\:*?"<>|]{1,150}\.(?:xlsx|pdf|html|png|pptx)$/i.test(file.name) || [...file.name].some(char => char.charCodeAt(0) < 32) || !(file.bytes instanceof Uint8Array) || file.bytes.length > 20 * 1024 * 1024) throw new Error("잘못된 출력 파일입니다.");
          if (/\.xlsx$/i.test(file.name)) await this.abortable(this.validateWorkbook(file.bytes, result.validationSheet), controller.signal);
          else {
            if (!tool.validateOutput || tool.updateSource) throw new Error("이 업무는 XLSX 결과만 지원합니다.");
            await this.abortable(tool.validateOutput(file, controller.signal), controller.signal);
          }
        }
        controller.signal.throwIfAborted();
        if (result.image) {
          if (!/^[^/\\:*?"<>|]{1,150}\.png$/i.test(result.image.name) || [...result.image.name].some((char) => char.charCodeAt(0) < 32) || !(result.image.bytes instanceof Uint8Array) || result.image.bytes.length > 20 * 1024 * 1024 || !Buffer.from(result.image.bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("잘못된 출력 이미지입니다.");
          const { default: sharp } = await import("sharp");
          const metadata = await this.abortable(sharp(result.image.bytes, { limitInputPixels: 96000000 }).metadata(), controller.signal);
          if (metadata.format !== "png" || !metadata.width || !metadata.height) throw new Error("PNG 이미지를 읽을 수 없습니다.");
          outputs.push(result.image);
        }
        if (tool.updateSource) {
          const selected = input.files[tool.updateSource]; const original = files[tool.updateSource];
          if (selected?.length !== 1 || original?.length !== 1) throw new Error("갱신할 원본 XLSX를 하나 선택해야 합니다.");
          new TraceWriter(this.db, runId).record("workflow.effect_started", "runtime", { localOnly: true, toolId: tool.id });
          await sources.replace(selected[0], original[0].fingerprint, result.file.bytes);
        }
        const artifacts = outputs.map((file) => ({ ...file, id: randomUUID() }));
        const message = `${result.summary}\n\n완성 파일: ${artifacts.map((file) => file.name).join(", ")}`;
        let transaction = false;
        try {
          await mkdir(this.outputDir, { recursive: true });
          for (const file of artifacts) {
            const directory = join(this.outputDir, file.id);
            await mkdir(directory);
            await writeFile(join(directory, file.name), file.bytes, { flag: "wx", mode: 0o600 });
          }
          controller.signal.throwIfAborted();
          this.db.exec("BEGIN"); transaction = true;
          job.revision = Number(this.db.prepare("SELECT COUNT(*) AS count FROM business_jobs j JOIN runs r ON r.id=j.run_id WHERE r.thread_id=? AND r.kind=? AND r.status='completed'").get(getRun(this.db, runId).threadId, tool.id)?.count ?? 0) + 1;
          for (const file of artifacts) this.db.prepare("INSERT INTO business_artifacts (id, run_id, name, fingerprint, audit) VALUES (?, ?, ?, ?, ?)").run(file.id, runId, file.name, hash(file.bytes), JSON.stringify({ checks: result.checks, externalData: result.externalData ?? {}, preview: result.previews?.includes(file.name) ?? false }));
          if (result.checkpoint) { job.checkpoint = result.checkpoint; this.save(runId, job); }
          else this.save(runId, job);
          this.finish(runId, message, "completed", false);
          this.db.exec("COMMIT"); transaction = false;
        } catch (error) {
          if (transaction) this.db.exec("ROLLBACK");
          await Promise.allSettled(artifacts.map((file) => rm(join(this.outputDir, file.id), { recursive: true, force: true })));
          throw error;
        }
        this.event(runId, "completed", { text: message, outcome: "success" });
      } else throw new Error("잘못된 업무 결과입니다.");
    } catch (error) {
      if (getRun(this.db, runId).status === "running") {
        const message = error instanceof Error ? error.message : String(error);
        const saved = this.job(runId); saved.lastError = { message }; this.save(runId, saved);
        this.retry(runId, message, error instanceof Error && "code" in error ? String(error.code) : undefined);
      }
    } finally { clearTimeout(timeout); this.active.delete(runId); }
  }

  async drain(runId: string): Promise<void> { await this.submissions.get(runId)?.catch(() => undefined); }

  cancel(runId: string) {
    this.job(runId);
    const run = getRun(this.db, runId);
    if (run.status !== "running" && run.status !== "waiting_user") return;
    this.active.get(runId)?.abort(new Error("작업을 중단했습니다."));
    this.turns.get(runId)?.abort(new Error("작업을 중단했습니다."));
    setRunStatus(this.db, runId, "cancelled", "CANCELLED");
    this.event(runId, "failed", { code: "CANCELLED", message: "작업을 중단했습니다." });
  }
  async stop() { for (const id of this.active.keys()) this.cancel(id); await Promise.allSettled([...this.pending]); }

  artifacts(threadId: string): BusinessArtifact[] {
    return this.db.prepare("SELECT a.id, a.run_id AS runId, a.name, a.audit, j.payload FROM business_artifacts a JOIN runs r ON r.id = a.run_id JOIN business_jobs j ON j.run_id = r.id WHERE r.thread_id = ? AND r.status = 'completed' ORDER BY r.created_at, r.rowid, a.rowid").all(threadId).map((row) => {
      const job = JSON.parse(String(row.payload)) as Job;
      const audit = JSON.parse(String(row.audit));
      return { id: String(row.id), runId: String(row.runId), name: String(row.name), toolId: job.toolId, version: job.version, revision: job.revision, baseArtifactId: job.baseArtifactId, preview: audit.preview === true, changes: audit.externalData?.changes };
    });
  }
  async artifactPath(id: string): Promise<string> {
    const row = this.db.prepare("SELECT a.fingerprint, a.name FROM business_artifacts a JOIN runs r ON r.id = a.run_id WHERE a.id = ? AND r.status = 'completed'").get(id);
    if (!row || !/^[a-f0-9-]{36}$/.test(id)) throw new Error("완료된 결과 파일이 없습니다.");
    const path = join(this.outputDir, id, String(row.name));
    if (hash(await readFile(path)) !== row.fingerprint) throw new Error("결과 파일이 변경되었습니다.");
    return path;
  }
  private job(runId: string): Job {
    const row = this.db.prepare("SELECT payload FROM business_jobs WHERE run_id = ?").get(runId);
    if (!row) throw new Error("등록된 업무 실행이 아닙니다.");
    return JSON.parse(String(row.payload)) as Job;
  }
  private save(runId: string, job: Job) {
    this.db.prepare("INSERT INTO business_jobs (run_id, payload) VALUES (?, ?) ON CONFLICT(run_id) DO UPDATE SET payload = excluded.payload").run(runId, JSON.stringify(job));
  }
  /** Confirmed source files and base values stay fixed; only pending follow-up answers remain editable. */
  private lockedKeys(job: Job): string[] {
    if (!job.confirmed || this.tools.get(job.toolId)?.editable) return [];
    const base = this.tools.get(job.toolId)?.fields ?? [];
    return [...Object.keys(job.fingerprints), ...Object.entries(job.input.values).filter(([key, value]) => value && (!job.pendingKeys?.includes(key) || base.some((field) => field.key === key))).map(([key]) => key)];
  }
  /** One line per editable field so the submitted answer reads as the user's turn in the thread. */
  private describeInput(job: Job, input: BusinessInput, only?: string[]): string {
    const locked = new Set(this.lockedKeys(job));
    return job.fields.filter((field) => only ? only.includes(field.key) : !locked.has(field.key)).map((field) => {
      if (field.type === "file") { const names = (input.files[field.key] ?? []).map((file) => file.name); return names.length ? `${field.label}: ${names.join(", ")}` : ""; }
      const value = input.values[field.key]?.trim() ?? "";
      if (!value) return "";
      if (field.confirm) return `${field.label}: 확인 완료`;
      if (field.cashRows) {
        try {
          const amounts = JSON.parse(value) as Record<string, { incoming: string; outgoing: string }>;
          return `${field.label}: ${field.cashRows.filter((row) => amounts[row.key]).map((row) => `${row.name} (${row.key}) 입금 ${amounts[row.key].incoming}, 출금 ${amounts[row.key].outgoing}`).join(" / ")}`;
        } catch { return `${field.label}: 금액 확인 필요`; }
      }
      if (field.accountRows) {
        try { return `${field.label}: ${Object.entries(JSON.parse(value)).map(([account, cell]) => `${account} → ${cell}`).join(", ")}`; }
        catch { return `${field.label}: 연결 위치 확인 필요`; }
      }
      if (field.type !== "movements") return `${field.label}: ${value}`;
      try { const edits = JSON.parse(value) as { changes?: unknown[]; add?: unknown[] }; return `${field.label}: 금액 수정 ${edits.changes?.length ?? 0}건, 추가 거래 ${edits.add?.length ?? 0}건`; }
      catch { return `${field.label}: ${value}`; }
    }).filter(Boolean).join("\n") || "확인";
  }
  private ask(runId: string, question: string) {
    const job = this.job(runId);
    const action: BusinessAction = { id: randomUUID(), type: "business_tool", title: this.tools.get(job.toolId)?.title ?? job.toolId, question, fields: job.fields, input: job.input, lockedKeys: this.lockedKeys(job), uploadOnly: this.tools.get(job.toolId)?.uploadOnly, revisionMode: Boolean(job.baseArtifactId), conversational: this.tools.get(job.toolId)?.editable };
    this.db.prepare("INSERT INTO run_actions (run_id, action) VALUES (?, ?) ON CONFLICT(run_id) DO UPDATE SET action = excluded.action").run(runId, JSON.stringify(action));
    setRunStatus(this.db, runId, "waiting_user");
    appendMessage(this.db, { threadId: getRun(this.db, runId).threadId, runId, role: "assistant", content: question });
    this.event(runId, "ask_user", { question, action });
  }
  private finish(runId: string, text: string, status: "completed" | "abstained", emit = true) {
    setRunStatus(this.db, runId, status);
    appendMessage(this.db, { threadId: getRun(this.db, runId).threadId, runId, role: "assistant", content: text });
    if (emit) this.event(runId, "completed", { text, outcome: status === "completed" ? "success" : "abstained" });
  }
  /** An error never ends the run by itself: the same input card comes back with the message, so answers survive and the user decides whether to fix, retry or stop. */
  private retry(runId: string, message: string, code?: string, recovery?: Recovery) {
    // A classified failure keeps its original reason and says what the person can do; nothing is re-run on its own.
    if (recovery) { this.ask(runId, `${message}\n\n${RECOVERY_GUIDE[recovery]}`); return; }
    if (code && !["LIMIT", "UNSUPPORTED"].includes(code)) {
      this.ask(runId, `처리 중 내부 오류가 발생했습니다 (${code}). 입력한 답변은 보관되어 있습니다. 같은 요청으로 다시 시도하거나 추가 지시를 보낼 수 있습니다.`);
      return;
    }
    this.ask(runId, `${message}\n\n${this.tools.get(this.job(runId).toolId)?.editable ? "채팅으로 추가 지시를 보내거나 📎로 파일을 더 첨부해 이어갈 수 있습니다." : "입력을 고친 뒤 다시 실행할 수 있습니다. 원천 파일이나 작업일을 바꿔야 하면 작업을 중단하고 새로 시작하세요."}`);
  }
  private event(runId: string, type: AgentStreamEvent["type"], payload: unknown) {
    const traceType = type === "ask_user" ? "run.waiting_user" : type === "completed" ? "run.completed" : type === "failed" ? "run.failed" : "tool.started";
    const seq = new TraceWriter(this.db, runId).record(traceType, "runtime", { localOnly: true });
    this.emit({ runId, seq, type, payload });
  }
  private validateFields(fields: BusinessField[]) {
    if (fields.some((field) => (field.type === "select" || field.options) && (!field.options?.length || field.options.length > 20 || new Set(field.options.map((o) => o.value)).size !== field.options.length))) throw new Error("잘못된 선택 항목입니다.");
    if (!fields.length || fields.length > 30 || new Set(fields.map((field) => field.key)).size !== fields.length || fields.some((field) => !fieldKey.test(field.key) || ["__proto__", "constructor", "prototype"].includes(field.key) || !["text", "date", "file", "number", "movements", "select"].includes(field.type))) throw new Error("잘못된 업무 입력 정의입니다.");
  }
  private validateInput(fields: BusinessField[], input: BusinessInput) {
    for (const key of Object.keys(input.values)) if (!fields.some((field) => field.key === key && field.type !== "file")) throw new Error("등록되지 않은 입력입니다.");
    for (const key of Object.keys(input.files)) if (!fields.some((field) => field.key === key && field.type === "file")) throw new Error("등록되지 않은 파일 항목입니다.");
    for (const field of fields) {
      const value = field.type === "file" ? input.files[field.key]?.length : input.values[field.key]?.trim();
      if (field.type === "select" && value && !field.options?.some((option) => option.value === value)) throw new Error(`${field.label}의 선택 값이 올바르지 않습니다.`);
      if (field.required && !value) throw new Error(`${field.label}을 지정해 주세요.`);
      if (field.type === "file" && !field.multiple && (input.files[field.key]?.length ?? 0) > 1) throw new Error(`${field.label}은 파일 하나만 지정할 수 있습니다.`);
      if (field.type === "date" && value && (!/^\d{4}-\d{2}-\d{2}$/.test(String(value)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)) throw new Error("유효한 기준일을 입력하세요.");
    }
  }
  private async abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    let abort!: () => void;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener("abort", abort, { once: true }); })]); }
    finally { signal.removeEventListener("abort", abort); }
  }
}
