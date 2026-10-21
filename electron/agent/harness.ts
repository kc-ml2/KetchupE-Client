import type { DatabaseSync } from "node:sqlite";
import type { AgentStreamEvent, AppliedContext, CitationSummary, RunStatus } from "../../src/app-types/Agent.types.ts";
import {
  AgentError,
  LIMITS,
  validateDecision,
  type Evidence,
  type Observation,
  type PolicyDecision,
  type PolicyProfile,
  type PolicyState,
  type PolicyTransition,
  type RunOutcome,
} from "./contracts.ts";
import { selectContext } from "./context.ts";
import type { ModelCallInfo, ModelClient } from "./modelClient.ts";
import { alwaysSearchDecision, derivePolicySignals, gatedDecision, profileFingerprint } from "./policy.ts";
import { appendMessage, createRun, findOpenRun, getRun, getThread, setRunStatus } from "./store.ts";
import { chunkToEvidence, normalizeQuery, resultToEvidence, withTimeout, type EvidenceSource, type SearchTools } from "./tools.ts";
import { readTrace, TraceWriter } from "./trace.ts";
import { stripInvalidCitations, validateCitations } from "./verify.ts";
import { cancelWaitingRun, type RunHandle } from "./runLifecycle.ts";

export type AnswerProfile = { modelAlias: string; promptVersion: string };
export type HarnessProfiles = { retrieval: Record<string, unknown>; policy: PolicyProfile; answer: AnswerProfile };
export type HarnessLimits = { [Key in keyof typeof LIMITS]: number };

export type HarnessOptions = {
  db: DatabaseSync;
  model: ModelClient;
  tools: SearchTools;
  profiles: HarnessProfiles;
  activeCollections: (workspaceId: string) => string[];
  emit?: (event: AgentStreamEvent) => void;
  limits?: Partial<HarnessLimits>;
  /** Extra fields for the run.started payload (variant, app version, corpus fingerprints, …); a function is read per run. */
  runMetadata?: Record<string, unknown> | (() => Record<string, unknown>);
  /** Called when a run stops running (completed, abstained, waiting_user, failed, cancelled). */
  onRunSettled?: (runId: string, status: RunStatus) => void;
};

export type { RunHandle } from "./runLifecycle.ts";

type RunContext = {
  runId: string;
  threadId: string;
  workspaceId: string;
  state: PolicyState;
  contextText: string;
  sources: Map<string, EvidenceSource>;
  searchCache: Map<string, Observation>;
  controller: AbortController;
  deadline: number;
  trace: TraceWriter;
  seq: number;
};

const NEIGHBOR_SPAN = 1;
const MAX_DECIDE_ATTEMPTS = 2;
const EXTERNAL_DOCUMENT_TIMEOUT_MS = 120_000;

const appliedContext = (state: PolicyState): AppliedContext => ({
  memories: state.selectedMemories,
});

export class Harness {
  private readonly limits: HarnessLimits;
  private readonly fingerprints: { retrieval: string; policy: string; answer: string };
  private readonly running = new Map<string, RunContext>();
  private readonly pausedSeqs = new Map<string, number>();
  private readonly options: HarnessOptions;

  constructor(options: HarnessOptions) {
    this.options = options;
    this.limits = { ...LIMITS, ...options.limits };
    this.fingerprints = {
      retrieval: profileFingerprint(options.profiles.retrieval),
      policy: profileFingerprint(options.profiles.policy),
      answer: profileFingerprint(options.profiles.answer),
    };
  }

  startRun(input: { workspaceId: string; threadId: string; text: string }): RunHandle {
    const { db } = this.options;
    const thread = getThread(db, input.threadId);
    if (thread.workspaceId !== input.workspaceId) throw new AgentError("INTERNAL", "대화의 작업 공간이 일치하지 않습니다.");
    if (!input.text.trim()) throw new AgentError("INTERNAL", "요청 내용을 입력하세요.");
    const open = findOpenRun(db, input.threadId);
    if (open && open.kind !== "agent") throw new AgentError("INTERNAL", "이 대화에 다른 작업이 진행 중입니다.");
    if (open?.status === "waiting_user") return this.resumeRun(open.id, input.text);
    if (open) throw new AgentError("INTERNAL", "a run is already in progress for this thread");

    const goal = input.text.trim();
    const runId = createRun(db, {
      threadId: thread.id,
      goal,
      retrievalProfile: this.fingerprints.retrieval,
      policyProfile: this.fingerprints.policy,
      answerProfile: this.fingerprints.answer,
    });
    const message = appendMessage(db, { threadId: thread.id, runId, role: "user", content: goal });
    const context = selectContext(db, { workspaceId: input.workspaceId, threadId: thread.id, userGoal: goal, excludeMessageId: message.id });
    const activeCollections = this.options.activeCollections(input.workspaceId);
    const state: PolicyState = {
      runId,
      step: 1,
      userGoal: goal,
      selectedMemories: context.memories,
      activeCollections,
      maruAvailable: Boolean(this.options.tools.maru),
      trolleyAvailable: Boolean(this.options.tools.trolley),
      externalDocuments: [],
      recentMessages: context.recentMessages.map(({ role, content }) => ({ role, content })),
      evidence: [],
      previousDecisions: [],
      remaining: {
        steps: Math.min(this.limits.maxSteps, this.options.profiles.policy.maxSteps),
        modelCalls: Math.min(this.limits.maxModelCalls, this.options.profiles.policy.maxModelCalls),
        searches: Math.min(this.limits.maxSearchCalls, this.options.profiles.policy.maxSearchCalls),
        verifies: Math.min(this.limits.maxVerifyCalls, this.options.profiles.policy.maxVerifyCalls),
        wallTimeMs: Math.min(this.limits.runTimeoutMs, this.options.profiles.policy.runTimeoutMs),
      },
    };
    const run = this.createContext(runId, thread.id, input.workspaceId, state, context.contextText);
    const metadata = typeof this.options.runMetadata === "function" ? this.options.runMetadata() : this.options.runMetadata;
    run.trace.record("run.started", "input", { workspaceId: input.workspaceId, threadId: thread.id, messageId: message.id, profiles: this.fingerprints, activeCollections, ...metadata });
    run.trace.record("context.selected", "context", { ...context.selected, tokenEstimate: context.tokenEstimate });
    return { runId, done: this.loop(run) };
  }

  resumeRun(runId: string, text: string): RunHandle {
    const { db } = this.options;
    const record = getRun(db, runId);
    if (record.kind !== "agent" || record.status !== "waiting_user") throw new AgentError("INTERNAL", `run ${runId} is not waiting for an agent reply`);
    if (!text.trim()) throw new AgentError("INTERNAL", "응답 내용을 입력하세요.");
    const decided = readTrace(db, runId).filter((event) => event.type === "policy.decided").at(-1);
    const started = readTrace(db, runId).find((event) => event.type === "run.started");
    if (!decided || !started) throw new AgentError("INTERNAL", "cannot resume without a recorded decision");
    const transition = decided.payload.transition as PolicyTransition;
    const remaining = decided.payload.remainingAfter as PolicyState["remaining"];
    const workspaceId = String(started.payload.workspaceId);
    const question = transition.decision.question ?? "";
    const reply = text.trim();
    const message = appendMessage(db, { threadId: record.threadId, runId, role: "user", content: reply });
    const state: PolicyState = {
      ...transition.state,
      maruAvailable: Boolean(this.options.tools.maru),
      trolleyAvailable: Boolean(this.options.tools.trolley),
      step: transition.state.step + 1,
      previousDecisions: [...transition.state.previousDecisions, "ASK"],
      recentMessages: [...transition.state.recentMessages, { role: "assistant", content: question }, { role: "user", content: reply }],
      lastObservation: { kind: "user", messageId: message.id },
      remaining,
    };
    const contextText = String(decided.payload.contextText ?? "");
    const run = this.createContext(runId, record.threadId, workspaceId, state, `${contextText}\n\nassistant: ${question}\nuser: ${reply}`.trim());
    for (const row of db.prepare("SELECT * FROM citations WHERE run_id = ?").all(runId) as Record<string, unknown>[]) {
      run.sources.set(String(row.evidence_id), {
        evidenceId: String(row.evidence_id),
        sourceId: String(row.source_id),
        chunkId: String(row.chunk_id),
        path: String(row.path),
        title: String(row.title),
        locator: JSON.parse(String(row.locator)),
      });
    }
    setRunStatus(db, runId, "running");
    run.trace.record("interaction.recorded", "feedback", { kind: "clarification_answered", messageId: message.id });
    return { runId, done: this.loop(run) };
  }

  cancelRun(runId: string): void {
    const run = this.running.get(runId);
    if (run) {
      run.controller.abort();
    } else if (cancelWaitingRun(this.options.db, runId, "agent")) {
      const seq = (this.pausedSeqs.get(runId) ?? 0) + 1;
      this.pausedSeqs.delete(runId);
      this.options.emit?.({ runId, seq, type: "failed", payload: { code: "CANCELLED", message: "cancelled" } });
      this.notifySettled(runId, "cancelled");
    }
  }

  private createContext(runId: string, threadId: string, workspaceId: string, state: PolicyState, contextText: string): RunContext {
    const run: RunContext = {
      runId,
      threadId,
      workspaceId,
      state,
      contextText,
      sources: new Map(),
      searchCache: new Map(),
      controller: new AbortController(),
      deadline: Date.now() + state.remaining.wallTimeMs,
      trace: new TraceWriter(this.options.db, runId),
      seq: 0,
    };
    this.running.set(runId, run);
    this.pausedSeqs.delete(runId);
    return run;
  }

  private emit(run: RunContext, type: AgentStreamEvent["type"], payload: unknown): void {
    run.seq += 1;
    this.options.emit?.({ runId: run.runId, seq: run.seq, type, payload });
  }

  private async loop(run: RunContext): Promise<void> {
    const { db } = this.options;
    try {
      while (true) {
        run.state.remaining.wallTimeMs = Math.max(0, run.deadline - Date.now());
        run.state.signals = derivePolicySignals(run.state);
        if (run.controller.signal.aborted) throw new AgentError("CANCELLED", "cancelled");
        const { remaining } = run.state;
        if (remaining.steps <= 0 || remaining.modelCalls <= 0 || remaining.wallTimeMs <= 0) {
          throw new AgentError("BUDGET_EXCEEDED", `budget exhausted at step ${run.state.step}`);
        }

        this.emit(run, "status", { step: run.state.step, phase: "deciding" });
        const decision = await this.decide(run);
        const stateSnapshot = structuredClone(run.state);
        run.state.remaining.steps -= 1;
        run.state.step += 1;
        run.state.previousDecisions.push(decision.action);

        const transition: PolicyTransition = { state: stateSnapshot, decision };
        const decidedSeq = run.trace.record("policy.decided", "policy", {
          transition,
          profileHash: this.fingerprints.policy,
          remainingAfter: run.state.remaining,
          contextText: decision.action === "ASK" ? run.contextText : undefined,
        });
        this.emit(run, "status", { step: stateSnapshot.step, phase: decision.action, reasonCode: decision.reasonCode, taskDifficulty: decision.taskDifficulty });

        switch (decision.action) {
          case "SEARCH":
            run.state.lastObservation = await this.search(run, decision, decidedSeq);
            this.updateTransition(run, decidedSeq, { observation: run.state.lastObservation });
            break;
          case "VERIFY":
            run.state.lastObservation = await this.verify(run, decision, decidedSeq);
            this.updateTransition(run, decidedSeq, { observation: run.state.lastObservation });
            break;
          case "ASK": {
            const question = decision.question ?? "";
            const context = appliedContext(run.state);
            const message = appendMessage(db, { threadId: run.threadId, runId: run.runId, role: "assistant", content: question, appliedContext: context });
            setRunStatus(db, run.runId, "waiting_user");
            this.updateTransition(run, decidedSeq, { outcome: "waiting_user" });
            run.trace.record("run.waiting_user", "runtime", { messageId: message.id });
            this.emit(run, "ask_user", { messageId: message.id, question });
            this.settle(run, "waiting_user");
            return;
          }
          case "ANSWER": {
            const outcome = await this.answer(run, decidedSeq);
            this.updateTransition(run, decidedSeq, { outcome });
            this.settle(run, "completed");
            return;
          }
          case "STOP": {
            const reason = decision.stopReason ?? "";
            const context = appliedContext(run.state);
            const message = appendMessage(db, { threadId: run.threadId, runId: run.runId, role: "assistant", content: reason, appliedContext: context });
            setRunStatus(db, run.runId, "abstained");
            this.updateTransition(run, decidedSeq, { outcome: "abstained" });
            run.trace.record("run.completed", "runtime", { outcome: "abstained", messageId: message.id, ...this.usage(run) });
            this.emit(run, "completed", { outcome: "abstained", messageId: message.id, text: reason, appliedContext: context });
            this.settle(run, "abstained");
            return;
          }
        }
      }
    } catch (error) {
      const failure = error instanceof AgentError ? error : new AgentError("INTERNAL", error instanceof Error ? error.message : String(error));
      const status = failure.code === "CANCELLED" ? "cancelled" : "failed";
      setRunStatus(db, run.runId, status, failure.code);
      run.trace.record("run.failed", "runtime", { code: failure.code, message: failure.message, step: run.state.step });
      this.emit(run, "failed", { code: failure.code, message: failure.message });
      this.settle(run, status);
    }
  }

  private settle(run: RunContext, status: RunStatus): void {
    this.running.delete(run.runId);
    if (status === "waiting_user") this.pausedSeqs.set(run.runId, run.seq);
    this.notifySettled(run.runId, status);
  }

  private notifySettled(runId: string, status: RunStatus): void {
    try {
      this.options.onRunSettled?.(runId, status);
    } catch (error) {
      console.warn("[harness] onRunSettled failed:", error);
    }
  }

  /** The policy.decided payload is the PolicyTransition record; observation and outcome are filled in as they happen. */
  private updateTransition(run: RunContext, seq: number, patch: Pick<PolicyTransition, "observation" | "outcome">): void {
    const row = this.options.db.prepare("SELECT payload FROM trace_events WHERE run_id = ? AND seq = ?").get(run.runId, seq) as { payload: string };
    const payload = JSON.parse(row.payload) as { transition: PolicyTransition };
    Object.assign(payload.transition, patch);
    this.options.db.prepare("UPDATE trace_events SET payload = ? WHERE run_id = ? AND seq = ?").run(JSON.stringify(payload), run.runId, seq);
  }

  private async callModel<T>(run: RunContext, purpose: ModelCallInfo["purpose"], call: () => Promise<T>): Promise<T> {
    if (run.state.remaining.modelCalls <= 0) throw new AgentError("BUDGET_EXCEEDED", `no model calls remaining for ${purpose}`);
    run.state.remaining.modelCalls -= 1;
    const startedAt = Date.now();
    const stage = purpose === "policy" ? "policy" : purpose === "verify" ? "verification" : "generation";
    const configuredAlias = purpose === "answer" ? this.options.profiles.answer.modelAlias : this.options.profiles.policy.modelAlias;
    const seq = run.trace.record("model.started", stage, { purpose, modelAlias: configuredAlias });
    const previous = this.options.model.lastCallFor ? this.options.model.lastCallFor(run.controller.signal) : this.options.model.lastCall;
    let code: string | undefined;
    try {
      return await withTimeout(call(), run.deadline - Date.now(), "MODEL_TIMEOUT", run.controller.signal);
    } catch (error) {
      code = error instanceof AgentError ? error.code : "INTERNAL";
      throw error;
    } finally {
      const last = this.options.model.lastCallFor ? this.options.model.lastCallFor(run.controller.signal) : this.options.model.lastCall;
      const usage = last && last !== previous && last.purpose === purpose ? { modelAlias: last.modelAlias, promptTokens: last.promptTokens, cachedPromptTokens: last.cachedPromptTokens, completionTokens: last.completionTokens, finishReason: last.finishReason, ttftMs: last.ttftMs } : {};
      run.trace.record("model.completed", stage, { purpose, latencyMs: Date.now() - startedAt, ...usage, ...(code ? { code } : {}) }, { parentSeq: seq, startedAt });
    }
  }

  private async decide(run: RunContext): Promise<PolicyDecision> {
    const { policy } = this.options.profiles;
    const wantsExternal = (Boolean(this.options.tools.maru) && /maru|마루/iu.test(run.state.userGoal))
      || (Boolean(this.options.tools.trolley) && /trolley|트롤리/iu.test(run.state.userGoal));
    if (policy.strategy === "always-search" && !wantsExternal) {
      const raw = alwaysSearchDecision(run.state, policy.version);
      const validation = validateDecision(raw, run.state, policy.allowedActions);
      if (validation.ok) return validation.decision;
      if (validation.code === "BUDGET_EXCEEDED") return this.coerce(run, raw);
      throw new AgentError(validation.code, validation.reason);
    }
    if (policy.strategy === "gated" && !wantsExternal) {
      const fast = gatedDecision(run.state, policy.version);
      const validation = fast && validateDecision(fast, run.state, policy.allowedActions);
      if (validation?.ok) return validation.decision;
    }

    let lastReason = "";
    for (let attempt = 1; attempt <= MAX_DECIDE_ATTEMPTS; attempt += 1) {
      if (run.state.remaining.modelCalls <= 0) break;
      let raw: PolicyDecision;
      try {
        raw = await this.callModel(run, "policy", () => this.options.model.decide(run.state, this.options.profiles.policy, run.controller.signal));
      } catch (error) {
        if (!(error instanceof AgentError) || error.code !== "INVALID_DECISION") throw error;
        lastReason = error.message;
        run.trace.record("policy.decided", "policy", { invalid: true, code: error.code, reason: lastReason, attempt });
        continue;
      }
      const validation = validateDecision(raw, run.state, policy.allowedActions);
      if (validation.ok) {
        const decision = validation.decision;
        const proposedSearch = decision.search;
        const duplicateSearch = decision.action === "SEARCH"
          && proposedSearch?.tool === "search_local_docs"
          && run.searchCache.has(normalizeQuery(proposedSearch.query));
        return duplicateSearch ? this.coerce(run, decision) : decision;
      }
      lastReason = validation.reason;
      run.trace.record("policy.decided", "policy", { invalid: true, code: validation.code, reason: validation.reason, raw, attempt });
      if (validation.code === "BUDGET_EXCEEDED") return this.coerce(run, raw);
    }
    throw new AgentError("INVALID_DECISION", lastReason || "model produced no valid decision");
  }

  /** Budget wins over the model: an over-budget action becomes ANSWER (with evidence) or STOP. */
  private coerce(run: RunContext, raw: unknown): PolicyDecision {
    const base = raw as Partial<PolicyDecision>;
    const common = {
      taskDifficulty: base.taskDifficulty ?? 2,
      predictedSuccess: base.predictedSuccess ?? 0,
      evidenceSufficiency: base.evidenceSufficiency ?? 0,
      reasonCode: "BUDGET_LIMIT" as const,
      policyVersion: this.options.profiles.policy.version,
    };
    const hasMaterial = run.state.evidence.length > 0 || run.state.lastObservation?.kind === "external";
    return hasMaterial && run.state.remaining.modelCalls > 0 && this.options.profiles.policy.allowedActions.includes("ANSWER")
      ? { ...common, action: "ANSWER" }
      : { ...common, action: "STOP", stopReason: "검색 예산을 모두 사용했지만 답변에 필요한 근거를 찾지 못했습니다." };
  }

  private usage(run: RunContext): { modelCalls: number; promptTokens: number; completionTokens: number; totalTokens: number } {
    const calls = readTrace(this.options.db, run.runId).filter((event) => event.type === "model.completed");
    const promptTokens = calls.reduce((sum, event) => sum + Number(event.payload.promptTokens ?? 0), 0);
    const completionTokens = calls.reduce((sum, event) => sum + Number(event.payload.completionTokens ?? 0), 0);
    return { modelCalls: calls.length, promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
  }

  private addEvidence(run: RunContext, items: Array<{ evidence: Evidence; source: EvidenceSource }>): string[] {
    const ids: string[] = [];
    for (const item of items) {
      const existing = run.state.evidence.find((known) => known.chunkId === item.evidence.chunkId);
      if (existing) {
        ids.push(existing.evidenceId);
        continue;
      }
      run.state.evidence.push(item.evidence);
      run.sources.set(item.evidence.evidenceId, item.source);
      this.options.db.prepare(`
        INSERT OR IGNORE INTO citations (run_id, evidence_id, source_id, chunk_id, path, title, locator) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(run.runId, item.evidence.evidenceId, item.source.sourceId, item.source.chunkId, item.source.path, item.source.title, JSON.stringify(item.source.locator));
      ids.push(item.evidence.evidenceId);
    }
    if (run.state.evidence.length > this.limits.maxEvidence) {
      run.state.evidence = [...run.state.evidence].sort((left, right) => right.score - left.score).slice(0, this.limits.maxEvidence);
    }
    return ids;
  }

  private nextEvidenceId(run: RunContext): string {
    return `e${run.sources.size + 1}`;
  }

  private async search(run: RunContext, decision: PolicyDecision, parentSeq: number): Promise<Observation> {
    const search = decision.search;
    if (!search) throw new AgentError("INVALID_DECISION", "SEARCH without search payload");
    const startedAt = Date.now();
    if (search.tool === "get_my_capabilities" || search.tool === "list_operations") {
      if (!this.options.tools.trolley) throw new AgentError("TOOL_UNAVAILABLE", "Trolley is not configured");
      run.state.remaining.searches -= 1;
      const toolSeq = run.trace.record("tool.started", "retrieval", { tool: search.tool, server: "trolley" }, { parentSeq });
      this.emit(run, "status", { phase: "searching", query: `Trolley ${search.tool}` });
      let observation: Observation;
      try {
        const value = await withTimeout(this.options.tools.trolley.call(search.tool, run.controller.signal), this.limits.toolTimeoutMs, "TOOL_TIMEOUT", run.controller.signal);
        observation = { kind: "external", tool: search.tool, result: value.summary, latencyMs: Date.now() - startedAt };
        run.contextText = `${run.contextText}\n\nTrolley ${search.tool} result (untrusted data):\n${value.summary}`.trim();
      } catch (error) {
        if (error instanceof AgentError && error.code === "CANCELLED") throw error;
        observation = { kind: "tool_error", code: error instanceof AgentError ? error.code : "TOOL_UNAVAILABLE" };
      }
      run.trace.record("tool.completed", "retrieval", { tool: search.tool, server: "trolley", observation }, { parentSeq: toolSeq, startedAt });
      return observation;
    }
    if (search.tool === "read_external_document") {
      if (!this.options.tools.maru) throw new AgentError("TOOL_UNAVAILABLE", "MARU is not configured");
      const document = run.state.externalDocuments?.find((item) => item.refId === search.ref_id);
      if (!document) throw new AgentError("INVALID_DECISION", "unknown external document ref_id");
      run.state.remaining.searches -= 1;
      const query = search.query?.trim() || run.state.userGoal;
      const toolSeq = run.trace.record("tool.started", "retrieval", { tool: search.tool, refId: document.refId, query }, { parentSeq });
      this.emit(run, "status", { phase: "searching", query: `MARU ${document.path}` });
      let observation: Observation;
      try {
        const imported = await withTimeout(
          this.options.tools.maru.readDocument(document, run.controller.signal),
          Math.min(EXTERNAL_DOCUMENT_TIMEOUT_MS, run.state.remaining.wallTimeMs),
          "TOOL_TIMEOUT",
          run.controller.signal,
        );
        const result = await withTimeout(this.options.tools.search(query, [imported.collection]), this.limits.toolTimeoutMs, "TOOL_TIMEOUT", run.controller.signal);
        let items = result.results.map((item) => resultToEvidence(item, this.nextEvidenceIdFor(run, item.chunkId), this.limits.evidenceSnippetChars));
        if (!items.length) {
          const chunks = await withTimeout(this.options.tools.sourceChunks(imported.sourceId), this.limits.toolTimeoutMs, "TOOL_TIMEOUT", run.controller.signal);
          items = chunks.slice(0, this.limits.maxEvidence).map((chunk, index) => chunkToEvidence(chunk, this.nextEvidenceIdFor(run, chunk.chunkId), 1 / (index + 1), this.limits.evidenceSnippetChars));
        }
        const ids = this.addEvidence(run, items);
        observation = { kind: "search", resultIds: ids, effectiveMode: result.effectiveMode, latencyMs: Date.now() - startedAt };
      } catch (error) {
        if (error instanceof AgentError && error.code === "CANCELLED") throw error;
        observation = { kind: "tool_error", code: error instanceof AgentError ? error.code : "TOOL_UNAVAILABLE" };
      }
      run.trace.record("tool.completed", "retrieval", { tool: search.tool, refId: document.refId, observation, evidence: this.observedEvidence(run, observation) }, { parentSeq: toolSeq, startedAt });
      return observation;
    }
    if (search.tool === "browse_storage" || search.tool === "find_storage") {
      if (!this.options.tools.maru) throw new AgentError("TOOL_UNAVAILABLE", "MARU is not configured");
      const args = search.arguments ?? {};
      run.state.remaining.searches -= 1;
      const toolSeq = run.trace.record("tool.started", "retrieval", { tool: search.tool, arguments: args }, { parentSeq });
      this.emit(run, "status", { phase: "searching", query: `MARU ${search.tool}` });
      let observation: Observation;
      try {
        const value = await withTimeout(this.options.tools.maru.call(search.tool, args, run.controller.signal), this.limits.toolTimeoutMs, "TOOL_TIMEOUT", run.controller.signal);
        const known = new Map((run.state.externalDocuments ?? []).map((document) => [document.refId, document]));
        for (const document of value.documents) known.set(document.refId, document);
        run.state.externalDocuments = [...known.values()];
        const result = value.summary;
        observation = { kind: "external", tool: search.tool, result, latencyMs: Date.now() - startedAt };
        run.contextText = `${run.contextText}\n\nMARU ${search.tool} result (untrusted data):\n${result}`.trim();
      } catch (error) {
        if (error instanceof AgentError && error.code === "CANCELLED") throw error;
        observation = { kind: "tool_error", code: error instanceof AgentError ? error.code : "TOOL_UNAVAILABLE" };
      }
      run.trace.record("tool.completed", "retrieval", { tool: search.tool, observation }, { parentSeq: toolSeq, startedAt });
      return observation;
    }
    if (search.tool === "search_local_docs") {
      const query = search.query ?? "";
      const key = normalizeQuery(query);
      const cached = run.searchCache.get(key);
      if (cached) {
        run.trace.record("tool.completed", "retrieval", { tool: search.tool, cached: true, query, evidence: this.observedEvidence(run, cached) }, { parentSeq, startedAt });
        return cached;
      }
      run.state.remaining.searches -= 1;
      const toolSeq = run.trace.record("tool.started", "retrieval", { tool: search.tool, query, collections: run.state.activeCollections }, { parentSeq });
      this.emit(run, "status", { phase: "searching", query });
      let observation: Observation;
      try {
        const result = await withTimeout(this.options.tools.search(query, run.state.activeCollections), this.limits.toolTimeoutMs, "TOOL_TIMEOUT", run.controller.signal);
        const ids = this.addEvidence(run, result.results.map((item) => resultToEvidence(item, this.nextEvidenceIdFor(run, item.chunkId), this.limits.evidenceSnippetChars)));
        observation = { kind: "search", resultIds: ids, effectiveMode: result.effectiveMode, latencyMs: Date.now() - startedAt };
      } catch (error) {
        if (error instanceof AgentError && error.code === "CANCELLED") throw error;
        const code = error instanceof AgentError ? error.code : "TOOL_UNAVAILABLE";
        observation = { kind: "tool_error", code };
      }
      run.searchCache.set(key, observation);
      run.trace.record("tool.completed", "retrieval", { tool: search.tool, observation, evidence: this.observedEvidence(run, observation) }, { parentSeq: toolSeq, startedAt });
      return observation;
    }

    const anchor = run.state.evidence.find((item) => item.evidenceId === search.evidenceId);
    if (!anchor) throw new AgentError("INVALID_DECISION", "unknown evidenceId for get_document_context");
    run.state.remaining.searches -= 1;
    const toolSeq = run.trace.record("tool.started", "retrieval", { tool: search.tool, evidenceId: anchor.evidenceId }, { parentSeq });
    let observation: Observation;
    try {
      const chunks = await withTimeout(this.options.tools.neighbors(anchor.chunkId, NEIGHBOR_SPAN, NEIGHBOR_SPAN), this.limits.toolTimeoutMs, "TOOL_TIMEOUT", run.controller.signal);
      const ids = this.addEvidence(run, chunks.map((chunk) => chunkToEvidence(chunk, this.nextEvidenceIdFor(run, chunk.chunkId), anchor.score, this.limits.evidenceSnippetChars)));
      observation = { kind: "search", resultIds: ids, effectiveMode: "keyword", latencyMs: Date.now() - startedAt };
    } catch (error) {
      if (error instanceof AgentError && error.code === "CANCELLED") throw error;
      observation = { kind: "tool_error", code: error instanceof AgentError ? error.code : "TOOL_UNAVAILABLE" };
    }
    run.trace.record("tool.completed", "retrieval", { tool: search.tool, observation, evidence: this.observedEvidence(run, observation) }, { parentSeq: toolSeq, startedAt });
    return observation;
  }

  private observedEvidence(run: RunContext, observation: Observation): Evidence[] {
    if (observation.kind !== "search") return [];
    const ids = new Set(observation.resultIds);
    return run.state.evidence.filter((item) => ids.has(item.evidenceId));
  }

  /** Reuses the id of an already-issued chunk so ids stay stable within a run. */
  private nextEvidenceIdFor(run: RunContext, chunkId: string): string {
    for (const source of run.sources.values()) if (source.chunkId === chunkId) return source.evidenceId;
    const id = this.nextEvidenceId(run);
    run.sources.set(id, { evidenceId: id, sourceId: "", chunkId, path: "", title: "", locator: {} });
    return id;
  }

  private async verify(run: RunContext, decision: PolicyDecision, parentSeq: number): Promise<Observation> {
    run.state.remaining.verifies -= 1;
    const claims = decision.claimsToVerify ?? [];
    const startedAt = Date.now();
    const result = await this.callModel(run, "verify", () =>
      this.options.model.verify({ userGoal: run.state.userGoal, claims, evidence: run.state.evidence }, this.options.profiles.policy, run.controller.signal),
    );
    const observation: Observation = { kind: "verification", supported: result.supported, missingClaims: result.missingClaims, confidence: result.confidence };
    run.trace.record("verification.completed", "verification", { claims, result }, { parentSeq, startedAt });
    return observation;
  }

  private async answer(run: RunContext, parentSeq: number): Promise<RunOutcome> {
    const { db } = this.options;
    const startedAt = Date.now();
    let text = "";
    let answerUsage = { promptTokens: 0, completionTokens: 0 };
    await this.callModel(run, "answer", async () => {
      const stream = this.options.model.streamAnswer(
        { userGoal: run.state.userGoal, context: run.contextText, evidence: run.state.evidence },
        { ...this.options.profiles.policy, ...this.options.profiles.answer },
        run.controller.signal,
      );
      for await (const event of stream) {
        if (run.controller.signal.aborted) throw new AgentError("CANCELLED", "cancelled");
        if (event.type === "text_delta") {
          text += event.text;
          this.emit(run, "text_delta", { text: event.text });
        } else {
          answerUsage = { promptTokens: event.promptTokens, completionTokens: event.completionTokens };
        }
      }
    });

    let check = validateCitations(text, run.state.evidence);
    let repaired = false;
    if (check.invalid.length) {
      text = stripInvalidCitations(text, check.invalid);
      repaired = true;
      check = validateCitations(text, run.state.evidence);
    }
    const citationsFailed = run.state.evidence.length > 0 && check.valid.length === 0;
    run.trace.record("answer.validated", "citation", { valid: check.valid, invalid: check.invalid, repaired, usage: answerUsage, failed: citationsFailed }, { parentSeq, startedAt });
    if (citationsFailed) throw new AgentError("INVALID_CITATION", "answer did not cite known evidence");

    const citations: CitationSummary[] = check.valid.map((id) => {
      const evidence = run.state.evidence.find((item) => item.evidenceId === id);
      return { evidenceId: id, title: evidence?.title ?? "", breadcrumb: evidence?.breadcrumb ?? [], page: evidence?.locator.pageStart };
    });
    for (const citation of citations) this.emit(run, "citation", citation);
    const context = appliedContext(run.state);
    const message = appendMessage(db, { threadId: run.threadId, runId: run.runId, role: "assistant", content: text, appliedContext: context });
    setRunStatus(db, run.runId, "completed");
    run.trace.record("run.completed", "runtime", { outcome: "success", messageId: message.id, citations: check.valid, answerUsage, ...this.usage(run) });
    this.emit(run, "completed", { outcome: "success", messageId: message.id, text, citations, appliedContext: context });
    return "success";
  }
}
