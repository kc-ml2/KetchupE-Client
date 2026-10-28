import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AgentStreamEvent, StartRunInput } from "../../src/app-types/Agent.types.ts";
import type { BusinessAction, BusinessArtifact, BusinessField, BusinessInput } from "../../src/app-types/BusinessTool.types.ts";
import { REVISE_REQUEST_TEXT } from "../../src/app-types/BusinessTool.types.ts";
import { appendMessage, createRun, getRun, getRunAction, setRunStatus } from "../agent/store.ts";
import { TraceWriter } from "../agent/trace.ts";
import type { AgentWorkflow } from "../agent/workflows.ts";
import { WorkSources } from "../work/sources.ts";
import { businessInputSchema, type BusinessTool } from "./contracts.ts";

/** `confirmed` flips on the first accepted submission; until then every prefilled value (suggested files, today's date) stays editable. */
type Job = { toolId: string; version: string; input: BusinessInput; fingerprints: Record<string, string[]>; fields: BusinessField[]; checkpoint?: Record<string, unknown>; pendingKeys?: string[]; confirmed?: boolean };
const emptyInput = (): BusinessInput => ({ values: {}, files: {} });
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fieldKey = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

export class BusinessFlow {
  private readonly tools = new Map<string, BusinessTool>();
  private readonly pending = new Set<Promise<void>>();
  private readonly active = new Map<string, AbortController>();
  constructor(private readonly db: DatabaseSync, tools: BusinessTool[], private readonly outputDir: string,
    private readonly emit: (event: AgentStreamEvent) => void,
    private readonly validateWorkbook: (bytes: Uint8Array, sheet?: string) => Promise<void>,
    private readonly timeoutMs = 120000) {
    for (const tool of tools) {
      if (this.tools.has(tool.id)) throw new Error("duplicate business tool");
      this.validateFields(tool.fields);
      this.tools.set(tool.id, tool);
    }
  }

  workflows(): AgentWorkflow[] {
    return [...this.tools.values()].map((tool) => ({ ...tool, kind: tool.id,
      start: (input) => this.start(tool, input), resume: (id, text) => this.resume(id, text), cancel: (id) => this.cancel(id),
    }));
  }

  private start(tool: BusinessTool, input: StartRunInput) {
    const runId = createRun(this.db, { threadId: input.threadId, goal: input.text, kind: tool.id, retrievalProfile: "local", policyProfile: `${tool.id}@${tool.version}`, answerProfile: "deterministic" });
    appendMessage(this.db, { threadId: input.threadId, runId, role: "user", content: input.text });
    new TraceWriter(this.db, runId).record("run.started", "runtime", { localOnly: true, toolId: tool.id, version: tool.version });
    let initial = emptyInput(), checkpoint: Record<string, unknown> | undefined;
    if (tool.editable) {
      const previous = this.db.prepare("SELECT j.payload FROM business_jobs j JOIN runs r ON r.id=j.run_id WHERE r.thread_id=? AND r.kind=? AND r.status='completed' ORDER BY r.created_at DESC LIMIT 1").get(input.threadId, tool.id);
      if (previous) {
        const job = JSON.parse(String(previous.payload)) as Job;
        initial = { files: job.input.files, values: { request: job.input.values.request, format: job.input.values.format ?? "", revision: input.text === REVISE_REQUEST_TEXT ? "" : input.text } };
        checkpoint = job.checkpoint ? { excelState: job.checkpoint.excelState, clarifications: job.checkpoint.clarifications } : undefined;
      } else initial.values.request = input.text;
    }
    this.save(runId, { toolId: tool.id, version: tool.version, input: initial, fingerprints: {}, fields: tool.fields, checkpoint });
    if (tool.unavailableReason) { this.finish(runId, tool.unavailableReason, "abstained"); return { runId, done: Promise.resolve() }; }
    if (!tool.suggest) {
      this.ask(runId, tool.initialQuestion ?? "기준 정보와 원천 파일을 지정해 주세요.");
      if (tool.editable && initial.files.source?.length && input.text !== REVISE_REQUEST_TEXT) return { runId, done: this.submit(runId, getRunAction(this.db, runId)!.id, initial) };
      return { runId, done: Promise.resolve() };
    }
    const done = this.suggest(tool).then(({ input, foundFiles }) => {
      this.save(runId, { ...this.job(runId), input });
      this.ask(runId, foundFiles ? "연결된 폴더에서 찾은 파일을 미리 채웠습니다. 확인하거나 바꾼 뒤 실행해 주세요." : "기준 정보와 원천 파일을 지정해 주세요.");
    });
    return { runId, done };
  }

  /** Lists every connected source; a source that cannot be read is skipped so the form still opens. Defaults (e.g. Seoul's today) apply even when no file matched. */
  private async suggest(tool: BusinessTool): Promise<{ input: BusinessInput; foundFiles: boolean }> {
    if (!tool.suggest) return { input: emptyInput(), foundFiles: false };
    const sources = new WorkSources(this.db);
    const listed = await Promise.allSettled(sources.list().map((source) => sources.files(source.id)));
    const files = listed.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    const input = tool.suggest(files, new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }));
    return { input, foundFiles: Object.values(input.files).some((list) => list.length) };
  }

  private resume(runId: string, text: string) {
    const job = this.job(runId);
    if (getRun(this.db, runId).status !== "waiting_user") throw new Error("입력 대기 중인 작업이 아닙니다.");
    if (/^(취소|중단|그만|cancel|stop)[.!\s]*$/i.test(text.trim())) this.cancel(runId);
    else if (this.tools.get(job.toolId)?.editable && job.input.files.source?.length) {
      const input = structuredClone(job.input);
      const pending = job.fields.find(field => job.pendingKeys?.includes(field.key) && field.type === "text");
      if (pending) input.values[pending.key] = text;
      else input.values.revision = [input.values.revision, text].filter(Boolean).join("\n");
      return { runId, done: this.submit(runId, getRunAction(this.db, runId)!.id, input) };
    } else {
      appendMessage(this.db, { threadId: getRun(this.db, runId).threadId, runId, role: "user", content: text });
      this.ask(runId, "입력 화면에서 확인 내용을 작성해 주세요. 확인되지 않은 대화 내용을 계산 입력으로 사용하지 않습니다.");
    }
    return { runId, done: Promise.resolve() };
  }

  submit(runId: string, actionId: string, raw: unknown): Promise<void> {
    const task = this.executeSubmission(runId, actionId, raw);
    this.pending.add(task);
    void task.then(() => this.pending.delete(task), () => this.pending.delete(task));
    return task;
  }

  private async executeSubmission(runId: string, actionId: string, raw: unknown): Promise<void> {
    const job = this.job(runId);
    const tool = this.tools.get(job.toolId);
    if (!tool || tool.version !== job.version) throw new Error("업무 버전이 변경되었습니다. 현재 작업을 중단하고 새로 요청해 주세요.");
    if (getRunAction(this.db, runId)?.id !== actionId || this.active.has(runId)) throw new Error("이미 처리되었거나 변경된 입력 요청입니다.");
    const input = businessInputSchema.parse(raw);
    const sourceChanged = JSON.stringify(input.files) !== JSON.stringify(job.input.files);
    const requestChanged = input.values.request !== job.input.values.request;
    const revised = tool.editable && (sourceChanged || requestChanged || input.values.revision !== job.input.values.revision || input.values.format !== job.input.values.format);
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
    this.validateInput(revised ? job.fields.map(field => tool.fields.some(base => base.key === field.key) ? field : { ...field, required: false }) : job.fields, input);
    if (!tool.editable && (job.confirmed && Object.entries(job.input.values).some(([key, value]) => value && input.values[key] !== value && (tool.fields.some((field) => field.key === key) || !job.pendingKeys?.includes(key))) || Object.keys(job.fingerprints).some((key) => JSON.stringify(input.files[key]) !== JSON.stringify(job.input.files[key])))) throw new Error("확정된 원천 자료나 기준 정보는 변경할 수 없습니다. 새 작업으로 요청해 주세요.");
    const controller = new AbortController();
    this.active.set(runId, controller);
    const timeout = setTimeout(() => controller.abort(new Error("업무 실행 시간이 초과되었습니다.")), tool.executionTimeoutMs ?? this.timeoutMs);
    appendMessage(this.db, { threadId: getRun(this.db, runId).threadId, runId, role: "user", content: this.describeInput(job, input) });
    setRunStatus(this.db, runId, "running");
    if (tool.editable) this.db.prepare("DELETE FROM run_actions WHERE run_id=?").run(runId);
    this.event(runId, "status", { phase: "원천 자료 확인 및 업무 실행 중", messagesChanged: true });
    try {
      const files: Parameters<BusinessTool["execute"]>[0]["files"] = {};
      const sources = new WorkSources(this.db);
      let totalBytes = 0;
      for (const [key, list] of Object.entries(input.files)) {
        files[key] = [];
        for (const file of list) {
          const value = await sources.read(file);
          totalBytes += value.bytes.length;
          if (totalBytes > 100 * 1024 * 1024) throw new Error("원천 자료 합계는 100MB 이하여야 합니다.");
          files[key].push({ ...value, name: file.name });
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
      const result = await this.abortable(tool.execute({ values: input.values, files, checkpoint: job.checkpoint ?? {}, signal: controller.signal, onProgress: (phase) => {
        if (!controller.signal.aborted && getRun(this.db, runId).status === "running") this.event(runId, "status", { phase });
      } }), controller.signal);
      controller.signal.throwIfAborted();
      if (Object.values(input.files).flat().some((file) => !sources.list().some((source) => source.id === file.sourceId))) throw new Error("실행 중 자료 연결이 해제되었습니다.");
      if (result.status === "needs_input") {
        this.validateFields(result.fields);
        const merged = new Map(job.fields.map((field) => [field.key, field]));
        for (const field of result.fields) {
          if (merged.has(field.key) && merged.get(field.key)!.type !== field.type) throw new Error("추가 입력 항목의 형식이 변경되었습니다.");
          merged.set(field.key, field);
        }
        job.fields = [...merged.values()]; this.validateFields(job.fields);
        job.pendingKeys = result.fields.map((field) => field.key);
        job.checkpoint = result.checkpoint ?? job.checkpoint;
        if (JSON.stringify(job.checkpoint ?? {}).length > 1000000) throw new Error("업무 중간 상태가 너무 큽니다.");
        this.save(runId, job); this.ask(runId, result.question);
      } else if (result.status === "failed") this.retry(runId, result.message);
      else if (result.status === "completed") {
        if (!result.checks.length || result.checks.some((check) => check.passed !== true)) throw new Error("업무 검증을 통과하지 못했습니다.");
        const outputs = [result.file, ...(result.additionalFiles ?? [])];
        if (outputs.length > 3 || new Set(outputs.map(file => file.name)).size !== outputs.length || outputs.reduce((size, file) => size + file.bytes.length, 0) > 60 * 1024 * 1024) throw new Error("출력 파일 수·이름·크기를 확인하세요.");
        if (result.checkpoint && JSON.stringify(result.checkpoint).length > 1000000) throw new Error("업무 중간 상태가 너무 큽니다.");
        for (const file of outputs) {
          if (!/^[^/\\:*?"<>|]{1,150}\.(?:xlsx|pdf|html)$/i.test(file.name) || [...file.name].some(char => char.charCodeAt(0) < 32) || !(file.bytes instanceof Uint8Array) || file.bytes.length > 20 * 1024 * 1024) throw new Error("잘못된 출력 파일입니다.");
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
          for (const file of artifacts) this.db.prepare("INSERT INTO business_artifacts (id, run_id, name, fingerprint, audit) VALUES (?, ?, ?, ?, ?)").run(file.id, runId, file.name, hash(file.bytes), JSON.stringify({ checks: result.checks, externalData: result.externalData ?? {} }));
          if (result.checkpoint) { job.checkpoint = result.checkpoint; this.save(runId, job); }
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
      if (getRun(this.db, runId).status === "running") this.retry(runId, error instanceof Error ? error.message : String(error));
    } finally { clearTimeout(timeout); this.active.delete(runId); }
  }

  cancel(runId: string) {
    this.job(runId);
    const run = getRun(this.db, runId);
    if (run.status !== "running" && run.status !== "waiting_user") return;
    this.active.get(runId)?.abort(new Error("작업을 중단했습니다."));
    setRunStatus(this.db, runId, "cancelled", "CANCELLED");
    this.event(runId, "failed", { code: "CANCELLED", message: "작업을 중단했습니다." });
  }
  async stop() { for (const id of this.active.keys()) this.cancel(id); await Promise.allSettled([...this.pending]); }

  artifacts(threadId: string): BusinessArtifact[] {
    return this.db.prepare("SELECT a.id, a.run_id AS runId, a.name, j.payload FROM business_artifacts a JOIN runs r ON r.id = a.run_id JOIN business_jobs j ON j.run_id = r.id WHERE r.thread_id = ? AND r.status = 'completed' ORDER BY r.created_at").all(threadId).map((row) => {
      const job = JSON.parse(String(row.payload)) as Job;
      return { id: String(row.id), runId: String(row.runId), name: String(row.name), toolId: job.toolId, version: job.version };
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
  private describeInput(job: Job, input: BusinessInput): string {
    const locked = new Set(this.lockedKeys(job));
    return job.fields.filter((field) => !locked.has(field.key)).map((field) => {
      if (field.type === "file") { const names = (input.files[field.key] ?? []).map((file) => file.name); return names.length ? `${field.label}: ${names.join(", ")}` : ""; }
      const value = input.values[field.key]?.trim() ?? "";
      if (!value) return "";
      if (field.type !== "movements") return `${field.label}: ${value}`;
      try { const edits = JSON.parse(value) as { changes?: unknown[]; add?: unknown[] }; return `${field.label}: 금액 수정 ${edits.changes?.length ?? 0}건, 추가 거래 ${edits.add?.length ?? 0}건`; }
      catch { return `${field.label}: ${value}`; }
    }).filter(Boolean).join("\n") || "확인";
  }
  private ask(runId: string, question: string) {
    const job = this.job(runId);
    const action: BusinessAction = { id: randomUUID(), type: "business_tool", title: this.tools.get(job.toolId)?.title ?? job.toolId, question, fields: job.fields, input: job.input, lockedKeys: this.lockedKeys(job) };
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
  private retry(runId: string, message: string) {
    this.ask(runId, `${message}\n\n${this.tools.get(this.job(runId).toolId)?.editable ? "요청이나 파일 선택을 수정하거나 채팅으로 추가 지시를 보내 이어갈 수 있습니다." : "입력을 고친 뒤 다시 실행할 수 있습니다. 원천 파일이나 작업일을 바꿔야 하면 작업을 중단하고 새로 시작하세요."}`);
  }
  private event(runId: string, type: AgentStreamEvent["type"], payload: unknown) {
    const traceType = type === "ask_user" ? "run.waiting_user" : type === "completed" ? "run.completed" : type === "failed" ? "run.failed" : "tool.started";
    const seq = new TraceWriter(this.db, runId).record(traceType, "runtime", { localOnly: true });
    this.emit({ runId, seq, type, payload });
  }
  private validateFields(fields: BusinessField[]) {
    if (fields.some((field) => field.type === "select" && (!field.options?.length || field.options.length > 20 || new Set(field.options.map((o) => o.value)).size !== field.options.length))) throw new Error("잘못된 선택 항목입니다.");
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
