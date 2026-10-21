// Document-authoring flow ported from the MARU LangGraph doc graph, without LangGraph:
//   classify → bind reference (ambiguous → awaiting_anchor_choice) → ground → draft → [awaiting_edit ⇄ apply op] → finalize
// One canvas session is one Run (kind = "canvas"); pauses are run.waiting_user events, like ASK in the harness.
import type { DatabaseSync } from "node:sqlite";
import type { AgentStreamEvent, RunStatus } from "../../../src/app-types/Agent.types.ts";
import type { AnchorCandidate, AnchorChoiceResumeContent, CanvasAtomicEditOp, CanvasEditOp, CanvasInterrupt, StartCanvasInput } from "../../../src/app-types/CanvasEdit.types.ts";
import type { ContractCanvas } from "../../../src/app-types/Canvas.types.ts";
import type { ChunkRecord, SourceRecord, TomatoSearch } from "../../tomato/tomato.ts";
import { AgentError, LIMITS, type PolicyProfile } from "../contracts.ts";
import type { ModelClient } from "../modelClient.ts";
import { appendMessage, createRun, findOpenRun, getRun, getThread, setRunStatus } from "../store.ts";
import { withTimeout } from "../tools.ts";
import { readTrace, TraceWriter } from "../trace.ts";
import { cancelWaitingRun, type RunHandle } from "../runLifecycle.ts";
import { DEFAULT_DOC_LABEL, getPreset, matchPresetByKeyword, matchPresetId, presetChoicesText, type DocPreset } from "./presets.ts";
import { blockEditPrompt, CANVAS_PROMPT_VERSION, classifyPrompt, draftPrompt, parseJsonObject } from "./prompts.ts";
import {
  createCanvas,
  findCanvasByRun,
  headVersion,
  nextVersion,
  previousVersion,
  serializeCanvas,
  setCanvasStatus,
  setCanvasTitle,
  setHead,
  writeVersion,
  type CanvasRecord,
  type CanvasReference,
  type CanvasVersion,
} from "./store.ts";
import {
  addBlock,
  assignIds,
  deleteBlock,
  documentContext,
  emptyPayload,
  extractTerms,
  fillTerms,
  findBlock,
  incompleteParties,
  reorderBlocks,
  setBlockText,
  setParties,
  validateSourceRefs,
  type CanvasPayload,
  type SourceRef,
} from "./tree.ts";

export interface CanvasRetrieval {
  search(query: string, collections: string[], limit: number): Promise<TomatoSearch>;
  getChunks(chunkIds: string[]): Promise<ChunkRecord[]>;
  listSources(collections: string[]): Promise<SourceRecord[]>;
  getSourceChunks(sourceId: string): Promise<ChunkRecord[]>;
}

export type CanvasFlowOptions = {
  db: DatabaseSync;
  model: ModelClient;
  retrieval: CanvasRetrieval;
  profile: PolicyProfile;
  activeCollections: (workspaceId: string) => string[];
  emit?: (event: AgentStreamEvent) => void;
  onRunSettled?: (runId: string, status: RunStatus) => void;
  /** Harness knobs varied by benchmarks; defaults are the product values. */
  limits?: { groundTopK?: number; anchorContextMaxChunks?: number };
  /** Replaces the preset guidance line of the draft prompt (prompt-axis experiments). */
  draftGuidance?: string;
};

export type CanvasHandle = RunHandle;

const GROUND_TOP_K = 8;
const MAX_ANCHOR_CANDIDATES = 5;
const MIN_ANCHOR_SCORE = 0.34;
const MIN_ANCHOR_MARGIN = 0.15;
const ANCHOR_CONTEXT_MAX_CHUNKS = 40;
const CANVAS_READY_MESSAGE = "문서 초안을 준비했습니다. 오른쪽 캔버스에서 확인하고 수정하세요.";

type PendingDraft = { workspaceId: string; instruction: string; preset: DocPreset; anchorOnly: boolean; candidates: AnchorCandidate[] };

const bigrams = (value: string): Set<string> => {
  const text = value.normalize("NFC").replace(/\s+/g, "");
  const out = new Set<string>();
  for (let index = 0; index < text.length - 1; index += 1) out.add(text.slice(index, index + 2));
  return out;
};

/** Fraction of the candidate name's bigrams covered by the request (0..1). */
export function anchorRelevance(instruction: string, name: string): number {
  const request = bigrams(instruction);
  const candidate = bigrams(name);
  if (!candidate.size) return 0;
  let shared = 0;
  for (const gram of candidate) if (request.has(gram)) shared += 1;
  return shared / candidate.size;
}

/** Template documents = file name contains every family word and any marker. */
export function templateCandidates(sources: SourceRecord[], preset: DocPreset): SourceRecord[] {
  if (!preset.anchorFamily.length) return [];
  return sources.filter((source) => {
    const name = source.relativePath.split("/").at(-1)?.normalize("NFC").toLowerCase() ?? "";
    return preset.anchorFamily.every((word) => name.includes(word.toLowerCase())) && preset.anchorMarkers.some((marker) => name.includes(marker.toLowerCase()));
  });
}

const chunkToReference = (chunk: ChunkRecord, score: number | null, kind?: "anchor"): CanvasReference => ({
  chunk_id: chunk.chunkId,
  document_id: chunk.sourceId,
  document_name: chunk.relativePath,
  path: chunk.path,
  score,
  content: [chunk.title, chunk.breadcrumb.join(" > "), chunk.body].filter(Boolean).join("\n"),
  ...(kind ? { kind } : {}),
});

const renderContext = (refs: CanvasReference[]): string => refs.map((ref) => `[${ref.chunk_id}] ${ref.document_name}\n${ref.content}`).join("\n\n---\n\n");

function anchorContext(refs: CanvasReference[], anchorOnly: boolean): string {
  const names = [...new Set(refs.map((ref) => ref.document_name))].sort();
  const label = names.join(", ");
  const header = names.length > 1
    ? `[기준 문서 : ${label}] 아래는 기준으로 삼을 표준 양식들이다. 여러 문서를 요청에 맞게 종합해 구조와 표현을 우선 참고해 작성하라.`
    : `[기준 문서${label ? ` : ${label}` : ""}] 아래는 표준 양식이다. 구조와 표현을 우선 참고해 작성하라.`;
  const strict = anchorOnly ? "[중요] 아래 기준 문서(표준 양식)만을 근거로 작성하라. 외부 지식이나 임의의 조항을 새로 만들지 말고, 표준의 구조·조항·표현을 요청에 맞게 충실히 따르라.\n\n" : "";
  return `${strict}${header}\n\n${renderContext(refs)}`;
}

export class CanvasFlow {
  private readonly options: CanvasFlowOptions;
  private readonly controllers = new Map<string, AbortController>();
  private readonly seqs = new Map<string, number>();

  constructor(options: CanvasFlowOptions) {
    this.options = options;
  }

  /** Starts a canvas run in the thread: classify → bind → (ask) → ground → draft → awaiting_edit. */
  start(input: StartCanvasInput): CanvasHandle {
    const { db } = this.options;
    const thread = getThread(db, input.threadId);
    if (thread.workspaceId !== input.workspaceId) throw new AgentError("INTERNAL", "대화의 작업 공간이 일치하지 않습니다.");
    if (!input.instruction.trim()) throw new AgentError("INTERNAL", "요청 내용을 입력하세요.");
    if (findOpenRun(db, thread.id)) throw new AgentError("INTERNAL", "이 대화에 진행 중인 작업이 있습니다.");
    const instruction = input.instruction.trim();
    const runId = createRun(db, { threadId: thread.id, goal: instruction, retrievalProfile: "canvas", policyProfile: CANVAS_PROMPT_VERSION, answerProfile: CANVAS_PROMPT_VERSION, kind: "canvas" });
    appendMessage(db, { threadId: thread.id, runId, role: "user", content: instruction });
    const trace = new TraceWriter(db, runId);
    trace.record("run.started", "input", { workspaceId: input.workspaceId, threadId: thread.id, kind: "canvas", canvasType: input.canvasType, anchorOnly: Boolean(input.anchorOnly) });
    const done = this.guard(runId, async (signal) => {
      const preset = await this.classify(runId, trace, instruction, input.canvasType, signal);
      const collections = this.options.activeCollections(input.workspaceId);
      const sources = await this.options.retrieval.listSources(collections);
      const ranked = templateCandidates(sources, preset)
        .map((source) => ({ source, score: anchorRelevance(instruction, source.relativePath.split("/").at(-1) ?? source.relativePath) }))
        .sort((left, right) => right.score - left.score);
      trace.record("tool.completed", "retrieval", { tool: "bind_reference", candidates: ranked.map(({ source, score }) => ({ id: source.sourceId, score })) });
      const clearWinner = ranked.length === 1 || (ranked.length > 1 && ranked[0].score >= MIN_ANCHOR_SCORE && ranked[0].score - ranked[1].score >= MIN_ANCHOR_MARGIN);
      const pending: PendingDraft = { workspaceId: input.workspaceId, instruction, preset, anchorOnly: Boolean(input.anchorOnly), candidates: [] };
      if (ranked.length && !clearWinner) {
        pending.candidates = ranked.slice(0, MAX_ANCHOR_CANDIDATES).map(({ source, score }) => ({ document_id: source.sourceId, name: source.relativePath, score: Math.round(score * 1000) / 1000 }));
        this.pause(runId, trace, { type: "awaiting_anchor_choice", candidates: pending.candidates }, pending);
        return;
      }
      const anchors = ranked.length ? await this.loadAnchors([ranked[0].source.sourceId]) : [];
      await this.draft(runId, trace, thread.id, pending, anchors, signal);
    });
    return { runId, done };
  }

  /** Resumes an awaiting_anchor_choice run with the user's pick. */
  resumeAnchorChoice(runId: string, choice: AnchorChoiceResumeContent): CanvasHandle {
    const { db } = this.options;
    const run = getRun(db, runId);
    if (run.kind !== "canvas" || run.status !== "waiting_user") throw new AgentError("INTERNAL", "참고 문서 선택을 기다리는 문서 작업이 아닙니다.");
    const waiting = readTrace(db, runId).filter((event) => event.type === "run.waiting_user").at(-1);
    const pending = waiting?.payload.pending as PendingDraft | undefined;
    if (!pending || (waiting?.payload.interrupt as CanvasInterrupt | undefined)?.type !== "awaiting_anchor_choice") throw new AgentError("INTERNAL", "복원할 참고 문서 선택 상태가 없습니다.");
    const trace = new TraceWriter(db, runId);
    setRunStatus(db, runId, "running");
    const allowed = new Set(pending.candidates.map((candidate) => candidate.document_id));
    const chosen = choice.skip ? [] : choice.document_ids.filter((id) => allowed.has(id));
    const names = pending.candidates.filter((candidate) => chosen.includes(candidate.document_id)).map((candidate) => candidate.name);
    appendMessage(db, { threadId: run.threadId, runId, role: "user", content: choice.skip ? "문서 참고 없이 진행할게요." : `참고 문서 선택: ${names.join(", ")}` });
    trace.record("interaction.recorded", "feedback", { kind: "clarification_answered", anchorChoice: { skip: choice.skip, documentIds: chosen, anchorOnly: choice.anchor_only } });
    const done = this.guard(runId, async (signal) => {
      const anchors = chosen.length ? await this.loadAnchors(chosen) : [];
      await this.draft(runId, trace, run.threadId, { ...pending, anchorOnly: pending.anchorOnly || Boolean(choice.anchor_only) }, anchors, signal);
    });
    return { runId, done };
  }

  /** Applies one edit command to the head version and pauses again (or finalizes). */
  applyEdit(runId: string, op: CanvasEditOp, displayText?: string): CanvasHandle {
    const { db } = this.options;
    const run = getRun(db, runId);
    if (run.kind !== "canvas" || run.status !== "waiting_user") throw new AgentError("INTERNAL", "편집을 기다리는 문서 작업이 아닙니다.");
    const canvas = findCanvasByRun(db, runId);
    if (!canvas) throw new AgentError("INTERNAL", "편집할 문서를 찾을 수 없습니다.");
    const trace = new TraceWriter(db, runId);
    setRunStatus(db, runId, "running");
    if (displayText) appendMessage(db, { threadId: run.threadId, runId, role: "user", content: displayText });
    const done = this.guard(runId, async (signal) => {
      const startedAt = Date.now();
      const head = headVersion(db, canvas);
      if (canvas.status === "finalized") {
        this.pauseEdit(runId, trace, canvas, head, "확정된 문서는 편집할 수 없습니다.");
        return;
      }
      if (op.op === "finalize") {
        await this.finalize(trace, run.threadId, canvas, head);
        return;
      }
      if (op.op === "undo" || op.op === "redo") {
        const target = op.op === "undo" ? previousVersion(db, head) : nextVersion(db, head);
        if (!target) {
          this.pauseEdit(runId, trace, canvas, head, op.op === "undo" ? "되돌릴 이전 버전이 없습니다." : "다시 실행할 다음 버전이 없습니다.");
          return;
        }
        setHead(db, canvas, target.id);
        trace.record("canvas.updated", "generation", { op: op.op, versionId: target.id }, { startedAt });
        this.pauseEdit(runId, trace, canvas, target, null);
        return;
      }
      const payload = structuredClone(head?.payload ?? emptyPayload());
      let changed = false;
      let error: string | null = null;
      if (op.op === "regenerate") {
        const feedback = op.feedback?.trim();
        if (!feedback) error = "재작성하려면 마음에 안 든 점을 feedback으로 보내주세요.";
        else {
          // A failed redraft must not kill the run: keep the current version and surface the reason.
          try {
            const regenerated = await this.generateTree(trace, { instruction: canvas.instruction, preset: getPreset(canvas.canvasType), context: renderContext(canvas.references), references: canvas.references, feedback, priorParties: payload.metadata.parties ?? [] }, signal);
            Object.assign(payload, regenerated);
            changed = true;
          } catch (cause) {
            if (cause instanceof AgentError && cause.code === "CANCELLED") throw cause;
            error = `재작성 실패: ${cause instanceof Error ? cause.message : String(cause)}`;
          }
        }
      } else if (op.op === "batch") {
        const errors: string[] = [];
        for (const [index, sub] of op.ops.entries()) {
          const result = await this.applyOne(trace, payload, canvas.canvasType, sub, signal);
          changed ||= result.changed;
          if (result.error) errors.push(`[${index}] ${result.error}`);
        }
        error = errors.join("; ") || null;
      } else {
        const result = await this.applyOne(trace, payload, canvas.canvasType, op, signal);
        changed = result.changed;
        error = result.error;
      }
      if (!changed) {
        this.pauseEdit(runId, trace, canvas, head, error);
        return;
      }
      if (canvas.status !== "editing") setCanvasStatus(db, canvas, "editing");
      const version = writeVersion(db, canvas, payload, op);
      trace.record("canvas.updated", "generation", { op: op.op, versionId: version.id, error }, { startedAt });
      this.pauseEdit(runId, trace, canvas, version, error);
    });
    return { runId, done };
  }

  cancel(runId: string): void {
    const controller = this.controllers.get(runId);
    if (controller) {
      controller.abort();
    } else if (cancelWaitingRun(this.options.db, runId, "canvas")) {
      this.emit(runId, "failed", { code: "CANCELLED", message: "cancelled" });
      this.settle(runId, "cancelled");
    }
  }

  /** Current canvas + interrupt for a run, used by the renderer to restore state. */
  view(runId: string): { canvas: ContractCanvas | null; interrupt: CanvasInterrupt | null } {
    const { db } = this.options;
    const run = getRun(db, runId);
    const canvas = findCanvasByRun(db, runId);
    const serialized = canvas ? serializeCanvas(canvas, headVersion(db, canvas)) : null;
    if (run.status !== "waiting_user") return { canvas: serialized, interrupt: null };
    const waiting = readTrace(db, runId).filter((event) => event.type === "run.waiting_user").at(-1);
    return { canvas: serialized, interrupt: (waiting?.payload.interrupt as CanvasInterrupt | undefined) ?? null };
  }

  sourcePath(canvasId: string, documentId: string): string | undefined {
    const row = this.options.db.prepare("SELECT refs FROM canvases WHERE id = ?").get(canvasId) as { refs: string } | undefined;
    if (!row) return undefined;
    return (JSON.parse(row.refs) as CanvasReference[]).find((ref) => ref.document_id === documentId)?.path;
  }

  // ---- internals ----

  private guard(runId: string, work: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    return work(controller.signal)
      .catch((error: unknown) => {
        const failure = error instanceof AgentError ? error : new AgentError("INTERNAL", error instanceof Error ? error.message : String(error));
        const status: RunStatus = failure.code === "CANCELLED" ? "cancelled" : "failed";
        setRunStatus(this.options.db, runId, status, failure.code);
        new TraceWriter(this.options.db, runId).record("run.failed", "runtime", { code: failure.code, message: failure.message });
        this.emit(runId, "failed", { code: failure.code, message: failure.message });
        this.settle(runId, status);
      })
      .finally(() => this.controllers.delete(runId));
  }

  private settle(runId: string, status: RunStatus): void {
    if (status !== "waiting_user") this.seqs.delete(runId);
    try {
      this.options.onRunSettled?.(runId, status);
    } catch (error) {
      console.warn("[canvas] onRunSettled failed:", error);
    }
  }

  private emit(runId: string, type: AgentStreamEvent["type"], payload: unknown): void {
    const seq = (this.seqs.get(runId) ?? 0) + 1;
    this.seqs.set(runId, seq);
    this.options.emit?.({ runId, seq, type, payload });
  }

  private async complete(trace: TraceWriter, prompt: string, signal: AbortSignal): Promise<string> {
    const startedAt = Date.now();
    const seq = trace.record("model.started", "generation", { purpose: "canvas", modelAlias: this.options.profile.modelAlias });
    const text = await withTimeout(this.options.model.complete({ prompt, purpose: "canvas" }, this.options.profile, signal), LIMITS.runTimeoutMs, "MODEL_TIMEOUT", signal);
    const last = this.options.model.lastCallFor ? this.options.model.lastCallFor(signal) : this.options.model.lastCall;
    trace.record("model.completed", "generation", { purpose: "canvas", latencyMs: Date.now() - startedAt, modelAlias: last?.modelAlias, promptTokens: last?.promptTokens, completionTokens: last?.completionTokens, finishReason: last?.finishReason }, { parentSeq: seq, startedAt });
    return text;
  }

  private async classify(runId: string, trace: TraceWriter, instruction: string, explicit: string | undefined, signal: AbortSignal): Promise<DocPreset> {
    if (explicit && getPreset(explicit).id === explicit) return getPreset(explicit);
    this.emit(runId, "status", { phase: "classifying" });
    let presetId: string | undefined;
    try {
      presetId = matchPresetId(await this.complete(trace, classifyPrompt(instruction, presetChoicesText()), signal));
    } catch (error) {
      if (error instanceof AgentError && error.code === "CANCELLED") throw error;
      presetId = undefined;
    }
    const preset = getPreset(presetId ?? matchPresetByKeyword(instruction));
    trace.record("tool.completed", "policy", { tool: "classify", preset: preset.id });
    return preset;
  }

  private async loadAnchors(sourceIds: string[]): Promise<CanvasReference[]> {
    const refs: CanvasReference[] = [];
    for (const sourceId of sourceIds) {
      const chunks = await this.options.retrieval.getSourceChunks(sourceId);
      refs.push(...chunks.slice(0, this.options.limits?.anchorContextMaxChunks ?? ANCHOR_CONTEXT_MAX_CHUNKS).map((chunk) => chunkToReference(chunk, null, "anchor")));
    }
    return refs;
  }

  private pause(runId: string, trace: TraceWriter, interrupt: CanvasInterrupt, pending?: PendingDraft): void {
    setRunStatus(this.options.db, runId, "waiting_user");
    trace.record("run.waiting_user", "runtime", { interrupt, pending });
    this.emit(runId, "ask_user", { interrupt });
    this.settle(runId, "waiting_user");
  }

  private pauseEdit(runId: string, trace: TraceWriter, canvas: CanvasRecord, version: CanvasVersion | undefined, error: string | null): void {
    const { db } = this.options;
    const serialized = serializeCanvas(canvas, version);
    this.emit(runId, "canvas", serialized);
    const interrupt: CanvasInterrupt = {
      type: "awaiting_edit",
      canvas_id: canvas.id,
      can_undo: Boolean(previousVersion(db, version)),
      can_redo: Boolean(nextVersion(db, version)),
      missing_parties: version ? incompleteParties(version.payload) : [],
      error,
    };
    this.pause(runId, trace, interrupt);
  }

  private async draft(runId: string, trace: TraceWriter, threadId: string, pending: PendingDraft, anchors: CanvasReference[], signal: AbortSignal): Promise<void> {
    const { db } = this.options;
    this.emit(runId, "status", { phase: "grounding" });
    const collections = this.options.activeCollections(pending.workspaceId);
    let ragRefs: CanvasReference[] = [];
    if (!pending.anchorOnly && collections.length) {
      const groundStart = Date.now();
      const search = await withTimeout(this.options.retrieval.search(pending.instruction, collections, this.options.limits?.groundTopK ?? GROUND_TOP_K), LIMITS.toolTimeoutMs, "TOOL_TIMEOUT", signal);
      const chunks = await this.options.retrieval.getChunks(search.results.map((result) => result.chunkId));
      ragRefs = chunks.map((chunk) => chunkToReference(chunk, search.results.find((result) => result.chunkId === chunk.chunkId)?.score ?? null));
      trace.record("tool.completed", "retrieval", { tool: "ground", effectiveMode: search.effectiveMode, results: ragRefs.length }, { startedAt: groundStart });
    }
    const references = [...anchors, ...ragRefs];
    const context = [anchors.length ? anchorContext(anchors, pending.anchorOnly) : "", renderContext(ragRefs)].filter(Boolean).join("\n\n");
    this.emit(runId, "status", { phase: "drafting" });
    const payload = await this.generateTree(trace, { instruction: pending.instruction, preset: pending.preset, context, references }, signal);
    const title = String(payload.metadata.title ?? "").trim() || pending.instruction.slice(0, 80);
    const canvas = createCanvas(db, { threadId, runId, canvasType: pending.preset.id, schemaVersion: pending.preset.schemaVersion, title, instruction: pending.instruction, references });
    const version = writeVersion(db, canvas, payload, null);
    trace.record("canvas.updated", "generation", { op: "draft", versionId: version.id, sections: payload.sections.length, missingTerms: payload.missing_terms.length });
    appendMessage(db, { threadId, runId, role: "assistant", content: CANVAS_READY_MESSAGE });
    this.pauseEdit(runId, trace, canvas, version, null);
  }

  private async generateTree(
    trace: TraceWriter,
    input: { instruction: string; preset: DocPreset; context: string; references: CanvasReference[]; feedback?: string; priorParties?: CanvasPayload["metadata"]["parties"] },
    signal: AbortSignal,
  ): Promise<CanvasPayload> {
    const preset = this.options.draftGuidance ? { ...input.preset, guidance: this.options.draftGuidance } : input.preset;
    const text = await this.complete(trace, draftPrompt({ preset, instruction: input.instruction, context: input.context, feedback: input.feedback }), signal);
    const tree = parseJsonObject(text);
    if (!Array.isArray(tree.sections) || !tree.sections.length) throw new AgentError("MODEL_PROTOCOL", "모델이 문서 구조(JSON)를 반환하지 않았습니다.");
    const payload = assignIds(tree);
    if (input.preset.parties.length) {
      const extracted = payload.metadata.parties ?? [];
      payload.metadata.parties = input.preset.parties.map((party) => ({ ...party }));
      setParties(payload, extracted);
    }
    if (input.priorParties?.length) {
      setParties(payload, input.priorParties.map((party) => Object.fromEntries(Object.entries(party).filter(([key, value]) => key === "label" || (typeof value === "string" && value.trim()))) as typeof party).filter((party) => Object.keys(party).length > 1));
    }
    validateSourceRefs(payload, new Map<string, SourceRef>(input.references.map((ref) => [ref.chunk_id, ref])));
    extractTerms(payload);
    return payload;
  }

  private async applyOne(trace: TraceWriter, payload: CanvasPayload, canvasType: string, op: CanvasAtomicEditOp, signal: AbortSignal): Promise<{ changed: boolean; error: string | null }> {
    const docType = getPreset(canvasType).label || DEFAULT_DOC_LABEL;
    try {
      switch (op.op) {
        case "edit": {
          const found = findBlock(payload, op.block_id);
          if (!found) return { changed: false, error: `블록을 찾을 수 없습니다: ${op.block_id}` };
          if (op.content !== undefined) return { changed: setBlockText(payload, op.block_id, op.content.trim(), []), error: null };
          if (!op.feedback) return { changed: false, error: "content 또는 feedback 중 하나는 필요합니다." };
          const rewritten = await this.complete(trace, blockEditPrompt({ docType, docContext: documentContext(payload), blockBody: typeof found[1].text === "string" ? found[1].text : "", feedback: op.feedback }), signal);
          return { changed: setBlockText(payload, op.block_id, rewritten.trim(), []), error: null };
        }
        case "add": {
          let content = op.content;
          if (content === undefined && op.feedback) {
            content = (await this.complete(trace, blockEditPrompt({ docType, docContext: documentContext(payload), blockBody: "(새 블록)", feedback: op.feedback }), signal)).trim();
          }
          const id = addBlock(payload, { text: content ?? "", ...(op.block_type ? { block_type: op.block_type } : {}) }, { afterBlockId: op.after_block_id, sectionId: op.section_id });
          return id ? { changed: true, error: null } : { changed: false, error: "블록을 추가할 섹션이 없습니다." };
        }
        case "delete":
          return deleteBlock(payload, op.block_id) ? { changed: true, error: null } : { changed: false, error: `블록을 찾을 수 없습니다: ${op.block_id}` };
        case "reorder":
          return reorderBlocks(payload, op.order.map(String), op.section_id) ? { changed: true, error: null } : { changed: false, error: "재정렬할 블록을 찾을 수 없습니다." };
        case "set_parties":
          return setParties(payload, op.parties ?? []) ? { changed: true, error: null } : { changed: false, error: "반영할 당사자 정보가 없습니다." };
        case "set_terms":
          return fillTerms(payload, op.terms ?? []) ? { changed: true, error: null } : { changed: false, error: "반영할 미정 항목 값이 없습니다." };
      }
    } catch (error) {
      if (error instanceof AgentError && error.code === "CANCELLED") throw error;
      return { changed: false, error: `편집 처리 오류: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private async finalize(trace: TraceWriter, threadId: string, canvas: CanvasRecord, head: CanvasVersion | undefined): Promise<void> {
    const { db } = this.options;
    const runId = trace.runId;
    setCanvasStatus(db, canvas, "finalized");
    const payload = head?.payload ?? emptyPayload();
    const title = String(payload.metadata.title ?? canvas.title ?? "");
    if (title && title !== canvas.title) setCanvasTitle(db, canvas, title);
    const label = getPreset(canvas.canvasType).label;
    const blocks = payload.sections.reduce((sum, section) => sum + section.blocks.length, 0);
    const parties = (payload.metadata.parties ?? []).map((party) => (party.name || party.label || "").trim()).filter(Boolean).join("·");
    const bits = [parties, `${payload.sections.length}개 섹션/${blocks}블록`, payload.missing_terms.length ? `미정 ${payload.missing_terms.length}건` : ""].filter(Boolean);
    const summary = `${title ? `${label} '${title}'` : label} 확정 · ${bits.join(" · ")}`;
    const message = appendMessage(db, { threadId, runId, role: "assistant", content: `문서를 확정했습니다 — ${summary}` });
    setRunStatus(db, runId, "completed");
    trace.record("run.completed", "runtime", { outcome: "success", messageId: message.id, canvasId: canvas.id, versionId: head?.id });
    this.emit(runId, "canvas", serializeCanvas(canvas, head));
    this.emit(runId, "completed", { outcome: "success", messageId: message.id, text: message.content, canvasId: canvas.id });
    this.settle(runId, "completed");
  }
}
