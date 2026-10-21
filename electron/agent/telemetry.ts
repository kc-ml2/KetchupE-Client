// Service-owned OTLP monitoring. SQLite is a durable outbox; Langfuse is the central trace/evaluation surface.
import { createHash, createHmac, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, cpus, totalmem } from "node:os";
import { extname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { InteractionKind } from "../../src/app-types/Agent.types.ts";
import type { EmbeddingReport, UpdateReport } from "../tomato/tomato.ts";
import type { PolicyTransition, TraceEvent } from "./contracts.ts";
import type { TelemetrySettings } from "./settings.ts";
import { readTrace } from "./trace.ts";

export const TELEMETRY_FLUSH_MS = 5_000;
export const TELEMETRY_REQUEST_TIMEOUT_MS = 30_000;
const TELEMETRY_RETRY_MAX_MS = 5 * 60_000;
const OUTBOX_LIMIT = 100;
export const TRAJECTORY_SCHEMA_VERSION = "ketchupe-trajectory-v2";

/** Retry-After may be delay-seconds or an HTTP date. Invalid values use local backoff. */
export function retryAfterMs(value: string | null, now = Date.now()): number {
  if (!value?.trim()) return 0;
  const trimmed = value.trim();
  const delay = /^\d+$/.test(trimmed) ? Number(trimmed) * 1000 : Date.parse(trimmed) - now;
  // Node timers overflow beyond 24.8 days; cap untrusted headers at the platform limit.
  return Number.isFinite(delay) ? Math.min(2_147_483_647, Math.max(0, delay)) : 0;
}

/** Anonymous, stable per install; never derived from the machine name or the user. */
export function loadInstallId(userData: string): string {
  const path = join(userData, "install-id");
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  mkdirSync(userData, { recursive: true });
  const id = randomUUID();
  writeFileSync(path, id);
  return id;
}

type AttrValue = string | number | boolean | string[];
type OtlpAttr = { key: string; value: { stringValue?: string; intValue?: string; doubleValue?: number; boolValue?: boolean; arrayValue?: { values: Array<{ stringValue: string }> } } };
type OtlpSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttr[];
  status?: { code: number; message?: string };
};

export type Score = { id?: string; traceId: string; parentSpanId?: string; name: string; value: number; dataType: "NUMERIC" | "BOOLEAN"; comment?: string };

const INTERACTION_SCORES: Record<InteractionKind, { name: string; value: number }> = {
  accepted: { name: "user_feedback", value: 1 },
  corrected: { name: "user_feedback", value: 0 },
  retried: { name: "retried", value: 1 },
  citation_opened: { name: "citation_opened", value: 1 },
  clarification_answered: { name: "clarification_answered", value: 1 },
  abandoned: { name: "abandoned", value: 1 },
  memory_confirmed: { name: "memory_feedback", value: 1 },
  memory_rejected: { name: "memory_feedback", value: 0 },
};

function attr(key: string, value: AttrValue | undefined): OtlpAttr[] {
  if (value === undefined || value === null || value === "") return [];
  if (Array.isArray(value)) return [{ key, value: { arrayValue: { values: value.map((item) => ({ stringValue: String(item) })) } } }];
  if (typeof value === "boolean") return [{ key, value: { boolValue: value } }];
  if (typeof value === "number") return Number.isInteger(value) ? [{ key, value: { intValue: String(value) } }] : [{ key, value: { doubleValue: value } }];
  return [{ key, value: { stringValue: value } }];
}

const nanos = (iso: string, plusMs = 0) => `${(Date.parse(iso) + plusMs) * 1_000_000}`;
const hmac = (key: string, value: string) => `hmac-sha256:${createHmac("sha256", key).update(value).digest("hex").slice(0, 32)}`;
const redactSensitiveText = (value: string) => value
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[EMAIL]")
  .replace(/(?<!\d)(?:\+?82[- ]?)?0?1[016789][ -]?\d{3,4}[ -]?\d{4}(?!\d)/gu, "[PHONE]")
  .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b/gu, "[SECRET]")
  .replace(/\bBearer\s+[A-Za-z0-9._~-]+/giu, "Bearer [SECRET]");
export const traceIdFor = (runId: string) => runId.replace(/-/g, "").padEnd(32, "0").slice(0, 32);
const spanIdFor = (runId: string, seq: number | string) => createHash("sha256").update(`${runId}:${seq}`).digest("hex").slice(0, 16);

const firstTokenIso = (event: TraceEvent) => event.payload.ttftMs === undefined ? undefined : new Date(Date.parse(event.startedAt) + Number(event.payload.ttftMs)).toISOString();

export type RunSummaryRow = { id: string; thread_id: string; goal: string; status: string; error_code: string | null; created_at: string; finished_at: string | null };

/** Builds the OTLP payload for one run from its trace_events. Pure; used by tests and the exporter. */
export function buildRunTrace(
  db: DatabaseSync,
  runId: string,
  options: { userId: string; identityKey: string; contentMode: TelemetrySettings["contentMode"]; environment: string; tenantId: string; resource: Record<string, string> },
): { traceId: string; payload: unknown; scores: Score[]; terminal: boolean } | undefined {
  const run = db.prepare("SELECT id, thread_id, goal, status, error_code, created_at, finished_at FROM runs WHERE id = ?").get(runId) as RunSummaryRow | undefined;
  if (!run) return undefined;
  const events = readTrace(db, runId);
  const started = events.find((event) => event.type === "run.started");
  if (started?.payload.localOnly === true) return undefined;
  const answer = db.prepare("SELECT content FROM messages WHERE run_id = ? AND role = 'assistant' ORDER BY rowid DESC LIMIT 1").get(runId) as { content: string } | undefined;
  const text = (value: string | undefined) => value === undefined
    ? undefined
    : options.contentMode === "internal_full"
      ? value
      : options.contentMode === "redacted_eval"
        ? redactSensitiveText(value)
        : hmac(options.identityKey, value);
  const id = (value: string | undefined) => value === undefined ? undefined : hmac(options.identityKey, value);
  const traceId = traceIdFor(runId);
  const rootSpanId = spanIdFor(runId, 0);
  const endIso = run.finished_at ?? events.at(-1)?.startedAt ?? run.created_at;

  const transitions = events.filter((event) => event.type === "policy.decided" && event.payload.transition);
  const decisions = transitions.map((event) => (event.payload.transition as PolicyTransition).decision);
  const usedExternal = transitions.some((event) => {
    const transition = event.payload.transition as PolicyTransition;
    return transition.observation?.kind === "external"
      || transition.decision.search?.tool === "browse_storage"
      || transition.decision.search?.tool === "find_storage"
      || transition.decision.search?.tool === "read_external_document";
  });
  const actions = decisions.map((decision) => decision.action);
  const validated = events.find((event) => event.type === "answer.validated")?.payload;
  const failed = events.find((event) => event.type === "run.failed")?.payload;
  const last = decisions.at(-1);
  const modelCalls = events.filter((event) => event.type === "model.completed");
  const tokens = modelCalls.reduce((sum, event) => sum + Number(event.payload.promptTokens ?? 0) + Number(event.payload.completionTokens ?? 0), 0);
  const variant = String(started?.payload.variant ?? "");
  const profiles = (started?.payload.profiles ?? {}) as Record<string, string>;
  const activeCollections = Array.isArray(started?.payload.activeCollections) ? started.payload.activeCollections.map(String).sort() : [];
  const corpusSnapshotId = hmac(options.identityKey, JSON.stringify({ activeCollections, retrievalProfile: profiles.retrieval ?? "" }));
  const fingerprintMap = (started?.payload.corpusFingerprints ?? {}) as Record<string, unknown>;
  const corpusFingerprints = activeCollections.map((name) => fingerprintMap[name]).filter((value): value is string => typeof value === "string" && value.length > 0).sort();
  const evidenceById = new Map(transitions.flatMap((event) => (event.payload.transition as PolicyTransition).state.evidence).map((item) => [item.evidenceId, item]));
  const terminal = run.status !== "running" && run.status !== "waiting_user";
  const tags = [variant || "unassigned", run.status].filter(Boolean);
  const traceAttributes = () => [
    ...attr("langfuse.trace.name", "agent.run"),
    ...attr("langfuse.user.id", options.userId),
    ...attr("langfuse.session.id", id(run.thread_id)),
    ...attr("langfuse.trace.tags", tags),
    ...attr("langfuse.release", options.resource["service.version"]),
    ...attr("langfuse.environment", options.environment),
    ...attr("langfuse.trace.metadata.trajectorySchemaVersion", TRAJECTORY_SCHEMA_VERSION),
    ...attr("langfuse.trace.metadata.contentMode", options.contentMode),
    ...attr("langfuse.trace.metadata.tenantId", id(options.tenantId)),
    ...attr("langfuse.trace.metadata.variant", variant),
    ...attr("langfuse.trace.metadata.policyProfileSha", profiles.policy),
    ...attr("langfuse.trace.metadata.retrievalProfileSha", profiles.retrieval),
    ...attr("langfuse.trace.metadata.answerProfileSha", profiles.answer),
    ...attr("langfuse.trace.metadata.corpusFingerprints", corpusFingerprints.length ? JSON.stringify(corpusFingerprints) : undefined),
  ];
  const exportLocator = (locator: PolicyTransition["state"]["evidence"][number]["locator"]) => ({
    ...locator,
    sheet: text(locator.sheet),
  });
  const exportEvidence = (evidence: PolicyTransition["state"]["evidence"]) => evidence.map((item, index) => ({
    rank: index + 1,
    evidenceId: item.evidenceId,
    sourceId: id(item.sourceId),
    chunkId: id(item.chunkId),
    title: text(item.title),
    breadcrumb: item.breadcrumb.map((part) => text(part)),
    locator: exportLocator(item.locator),
    snippet: text(item.snippet),
    score: item.score,
  }));
  const exportObservation = (observation: PolicyTransition["observation"]) => observation?.kind === "external"
    ? { kind: observation.kind, tool: observation.tool, latencyMs: observation.latencyMs, result: observation.tool === "get_my_capabilities" || observation.tool === "list_operations" ? "[TROLLEY_RESULT_OMITTED]" : "[MARU_RESULT_OMITTED]" }
    : observation?.kind === "verification"
      ? { ...observation, missingClaims: observation.missingClaims.map((claim) => text(claim)) }
      : observation?.kind === "user"
        ? { ...observation, messageId: id(observation.messageId) }
        : observation;
  const exportState = (state: PolicyTransition["state"]) => ({
    userGoal: text(state.userGoal),
    selectedMemories: state.selectedMemories.map((memory) => ({ ...memory, id: id(memory.id), content: text(memory.content) })),
    recentMessages: state.recentMessages.map((message) => ({ ...message, content: text(message.content) })),
    activeCollections: state.activeCollections.map((name) => text(name)),
    maruAvailable: state.maruAvailable,
    trolleyAvailable: state.trolleyAvailable,
    evidence: exportEvidence(state.evidence),
    signals: state.signals,
    previousDecisions: state.previousDecisions,
    lastObservation: exportObservation(state.lastObservation),
    remaining: state.remaining,
  });
  const exportDecision = (decision: PolicyTransition["decision"]) => ({
    ...decision,
    search: !decision.search
      ? undefined
      : decision.search.tool === "browse_storage" || decision.search.tool === "find_storage"
        ? { tool: decision.search.tool, arguments: "[MARU_ARGUMENTS_OMITTED]" }
        : decision.search.tool === "read_external_document"
          ? { tool: decision.search.tool, ref_id: id(decision.search.ref_id), query: text(decision.search.query) }
        : { ...decision.search, ...("query" in decision.search ? { query: text(decision.search.query) } : {}) },
    question: text(decision.question),
    claimsToVerify: decision.claimsToVerify?.map((claim) => text(claim)),
    stopReason: text(decision.stopReason),
  });

  const spans: OtlpSpan[] = [
    {
      traceId,
      spanId: rootSpanId,
      name: "agent.run",
      kind: 1,
      startTimeUnixNano: nanos(run.created_at),
      endTimeUnixNano: nanos(endIso),
      attributes: [
        ...attr("langfuse.observation.type", "agent"),
        ...traceAttributes(),
        ...attr("langfuse.observation.input", text(run.goal)),
        ...attr("langfuse.observation.output", usedExternal ? undefined : text(answer?.content)),
        ...attr("langfuse.trace.metadata.status", run.status),
        ...attr("langfuse.trace.metadata.errorCode", run.error_code ?? undefined),
        ...attr("langfuse.trace.metadata.actions", actions.join(">")),
        ...attr("langfuse.trace.metadata.steps", transitions.length),
        ...attr("langfuse.trace.metadata.searches", actions.filter((action) => action === "SEARCH").length),
        ...attr("langfuse.trace.metadata.verifies", actions.filter((action) => action === "VERIFY").length),
        ...attr("langfuse.trace.metadata.modelCalls", modelCalls.length),
        ...attr("langfuse.trace.metadata.totalTokens", tokens),
        ...attr("langfuse.trace.metadata.citationsValid", validated ? (validated.valid as string[]).length : undefined),
        ...attr("langfuse.trace.metadata.citationsRepaired", validated ? Boolean(validated.repaired) : undefined),
        ...attr("langfuse.trace.metadata.lastDifficulty", last?.taskDifficulty),
        ...attr("langfuse.trace.metadata.lastPredictedSuccess", last?.predictedSuccess),
        ...attr("langfuse.trace.metadata.corpusSnapshotId", corpusSnapshotId),
        ...attr("langfuse.trace.metadata.collectionCount", activeCollections.length),
        ...attr("langfuse.observation.level", failed ? "ERROR" : "DEFAULT"),
        ...attr("langfuse.observation.status_message", failed ? text(`${String(failed.code)}: ${String(failed.message)}`) : undefined),
      ],
      status: failed ? { code: 2, message: String(failed.code) } : { code: 1 },
    },
  ];

  const stepSpanBySeq = new Map<number, string>();
  for (const event of transitions) {
    const transition = event.payload.transition as PolicyTransition;
    const { decision, state } = transition;
    const next = events.find((candidate) => candidate.seq > event.seq && (candidate.type === "policy.decided" || candidate.type.startsWith("run.")));
    const spanId = spanIdFor(runId, event.seq);
    stepSpanBySeq.set(event.seq, spanId);
    spans.push({
      traceId,
      spanId,
      parentSpanId: rootSpanId,
      name: `policy.step.${state.step}`,
      kind: 1,
      startTimeUnixNano: nanos(event.startedAt),
      endTimeUnixNano: nanos(next?.startedAt ?? endIso),
      attributes: [
        ...attr("langfuse.observation.type", "agent"),
        ...traceAttributes(),
        ...attr("langfuse.observation.input", JSON.stringify(exportState(state))),
        ...attr("langfuse.observation.output", JSON.stringify({ decision: exportDecision(decision), observation: exportObservation(transition.observation), outcome: transition.outcome })),
        ...attr("langfuse.observation.metadata.action", decision.action),
        ...attr("langfuse.observation.metadata.reasonCode", decision.reasonCode),
        ...attr("langfuse.observation.metadata.taskDifficulty", decision.taskDifficulty),
        ...attr("langfuse.observation.metadata.predictedSuccess", decision.predictedSuccess),
        ...attr("langfuse.observation.metadata.evidenceSufficiency", decision.evidenceSufficiency),
        ...attr("langfuse.observation.metadata.evidenceCount", state.evidence.length),
        ...attr("langfuse.observation.metadata.observation", transition.observation?.kind),
        ...attr("langfuse.observation.metadata.effectiveMode", transition.observation?.kind === "search" ? transition.observation.effectiveMode : undefined),
        ...attr("langfuse.observation.metadata.outcome", transition.outcome),
      ],
    });
  }

  const parentFor = (event: TraceEvent): string => {
    let cursor: TraceEvent | undefined = event;
    while (cursor?.parentSeq !== undefined) {
      const known = stepSpanBySeq.get(cursor.parentSeq);
      if (known) return known;
      cursor = events.find((candidate) => candidate.seq === cursor?.parentSeq);
    }
    return rootSpanId;
  };

  for (const event of events) {
    if (event.type === "tool.completed") {
      const observation = event.payload.observation as { kind?: string; effectiveMode?: string; resultIds?: string[]; code?: string } | undefined;
      const startedEvent = events.find((candidate) => candidate.seq === event.parentSeq);
      const query = String(event.payload.query ?? startedEvent?.payload.query ?? "") || undefined;
      const evidence = event.payload.evidence
        ? event.payload.evidence as PolicyTransition["state"]["evidence"]
        : (observation?.resultIds ?? []).flatMap((id) => evidenceById.get(id) ?? []);
      spans.push({
        traceId,
        spanId: spanIdFor(runId, event.seq),
        parentSpanId: parentFor(event),
        name: `tool.${String(event.payload.tool)}`,
        kind: 1,
        startTimeUnixNano: nanos(event.startedAt),
        endTimeUnixNano: nanos(event.startedAt, event.durationMs ?? 0),
        attributes: [
          ...attr("langfuse.observation.type", "retriever"),
          ...traceAttributes(),
          ...attr("langfuse.observation.input", query ? text(query) : JSON.stringify({ evidenceId: startedEvent?.payload.evidenceId })) ,
          ...attr("langfuse.observation.output", JSON.stringify(exportEvidence(evidence))),
          ...attr("langfuse.observation.metadata.cached", Boolean(event.payload.cached)),
          ...attr("langfuse.observation.metadata.effectiveMode", observation?.effectiveMode),
          ...attr("langfuse.observation.metadata.results", observation?.resultIds?.length),
          ...attr("langfuse.observation.metadata.error", observation?.kind === "tool_error" ? observation.code : undefined),
          ...attr("langfuse.observation.level", observation?.kind === "tool_error" ? "ERROR" : "DEFAULT"),
        ],
      });
    }
    if (event.type === "model.completed") {
      const usage = { input: Number(event.payload.promptTokens ?? 0), output: Number(event.payload.completionTokens ?? 0) };
      spans.push({
        traceId,
        spanId: spanIdFor(runId, event.seq),
        parentSpanId: parentFor(event),
        name: `model.${String(event.payload.purpose)}`,
        kind: 3,
        startTimeUnixNano: nanos(event.startedAt),
        endTimeUnixNano: nanos(event.startedAt, event.durationMs ?? 0),
        attributes: [
          ...attr("langfuse.observation.type", "generation"),
          ...traceAttributes(),
          ...attr("langfuse.observation.model.name", event.payload.modelAlias === undefined ? undefined : String(event.payload.modelAlias)),
          ...attr("langfuse.observation.usage_details", JSON.stringify({ input: usage.input, output: usage.output, total: usage.input + usage.output })),
          ...attr("langfuse.observation.completion_start_time", firstTokenIso(event)),
          ...attr("langfuse.observation.metadata.ttftMs", event.payload.ttftMs === undefined ? undefined : Number(event.payload.ttftMs)),
          ...attr("langfuse.observation.metadata.cachedPromptTokens", event.payload.cachedPromptTokens === undefined ? undefined : Number(event.payload.cachedPromptTokens)),
          ...attr("langfuse.observation.metadata.purpose", String(event.payload.purpose)),
          ...attr("langfuse.observation.metadata.finishReason", event.payload.finishReason === undefined ? undefined : String(event.payload.finishReason)),
        ],
      });
    }
  }

  // User-perceived wait: from the message that (re)started the run to the first answer token, policy and search included.
  const answerCall = modelCalls.find((event) => event.payload.purpose === "answer" && event.payload.ttftMs !== undefined);
  const firstTokenAt = answerCall && firstTokenIso(answerCall);
  if (firstTokenAt) {
    const resumed = events.filter((event) => event.type === "interaction.recorded" && event.payload.kind === "clarification_answered").at(-1);
    spans.push({
      traceId,
      spanId: spanIdFor(runId, "ttft"),
      parentSpanId: rootSpanId,
      name: "agent.time_to_first_token",
      kind: 1,
      startTimeUnixNano: nanos(resumed?.startedAt ?? run.created_at),
      endTimeUnixNano: nanos(firstTokenAt),
      attributes: [...attr("langfuse.observation.type", "span"), ...traceAttributes()],
    });
  }

  const scores: Score[] = terminal
    ? [
        { traceId, parentSpanId: rootSpanId, name: "runtime/completed", value: run.status === "completed" ? 1 : 0, dataType: "BOOLEAN", comment: run.status },
        ...(validated ? [{ traceId, parentSpanId: rootSpanId, name: "runtime/citation_valid", value: validated.failed ? 0 : 1, dataType: "BOOLEAN" as const }] : []),
        ...(last ? [{ traceId, parentSpanId: rootSpanId, name: "agent/predicted_success", value: last.predictedSuccess, dataType: "NUMERIC" as const }] : []),
        { traceId, parentSpanId: rootSpanId, name: "runtime/steps", value: transitions.length, dataType: "NUMERIC" },
        { traceId, parentSpanId: rootSpanId, name: "runtime/searches", value: actions.filter((action) => action === "SEARCH").length, dataType: "NUMERIC" },
      ]
    : [];

  const payload = {
    resourceSpans: [
      {
        resource: { attributes: Object.entries(options.resource).flatMap(([key, value]) => attr(key, value)) },
        scopeSpans: [{ scope: { name: "ketchupe-agent" }, spans }],
      },
    ],
  };
  return { traceId, payload, scores, terminal };
}

export function interactionScore(runId: string, kind: InteractionKind): Score {
  const mapped = INTERACTION_SCORES[kind];
  return { traceId: traceIdFor(runId), parentSpanId: spanIdFor(runId, 0), name: `user/${mapped.name}`, value: mapped.value, dataType: mapped.name === "user_feedback" || mapped.name === "memory_feedback" ? "BOOLEAN" : "NUMERIC", comment: kind };
}

export type IndexSyncTelemetry = {
  collection: string;
  startedAt: string;
  durationMs: number;
  report?: UpdateReport;
  embedding?: EmbeddingReport & { durationMs: number };
  error?: string;
};

function buildIndexTrace(
  idValue: string,
  input: IndexSyncTelemetry,
  options: { identityKey: string; contentMode: TelemetrySettings["contentMode"]; environment: string; tenantId: string; resource: Record<string, string> },
): unknown {
  const traceId = traceIdFor(idValue);
  const rootSpanId = spanIdFor(idValue, 0);
  const text = (value: string) => options.contentMode === "internal_full"
    ? value
    : options.contentMode === "redacted_eval"
      ? redactSensitiveText(value)
      : hmac(options.identityKey, value);
  const common = [
    ...attr("langfuse.trace.name", "index.sync"),
    ...attr("langfuse.trace.tags", [input.error ? "failed" : "completed", "index.sync"]),
    ...attr("langfuse.release", options.resource["service.version"]),
    ...attr("langfuse.environment", options.environment),
    ...attr("langfuse.trace.metadata.trajectorySchemaVersion", TRAJECTORY_SCHEMA_VERSION),
    ...attr("langfuse.trace.metadata.contentMode", options.contentMode),
    ...attr("langfuse.trace.metadata.tenantId", hmac(options.identityKey, options.tenantId)),
  ];
  const report = input.report;
  const output = {
    scanned: report?.scanned ?? 0,
    updated: report?.updated ?? 0,
    unchanged: report?.unchanged ?? 0,
    removed: report?.removed ?? 0,
    failed: report?.failed.map((failure) => ({ extension: extname(failure.path).toLowerCase(), error: text(failure.error) })) ?? [],
    pipelineFingerprint: report?.pipelineFingerprint,
  };
  const spans: OtlpSpan[] = [{
    traceId,
    spanId: rootSpanId,
    name: "index.sync",
    kind: 1,
    startTimeUnixNano: nanos(input.startedAt),
    endTimeUnixNano: nanos(input.startedAt, input.durationMs),
    attributes: [
      ...attr("langfuse.observation.type", "chain"),
      ...common,
      ...attr("langfuse.observation.input", JSON.stringify({ collection: text(input.collection) })),
      ...attr("langfuse.observation.output", JSON.stringify(output)),
      ...attr("langfuse.observation.metadata.pipelineProfileSha", report?.pipelineFingerprint),
      ...attr("langfuse.observation.metadata.scanned", report?.scanned),
      ...attr("langfuse.observation.metadata.updated", report?.updated),
      ...attr("langfuse.observation.metadata.failed", report?.failed.length),
      ...attr("langfuse.observation.level", input.error ? "ERROR" : "DEFAULT"),
      ...attr("langfuse.observation.status_message", input.error ? text(input.error) : undefined),
    ],
    status: input.error ? { code: 2, message: "INDEX_SYNC_FAILED" } : { code: 1 },
  }];
  if (input.embedding) {
    spans.push({
      traceId,
      spanId: spanIdFor(idValue, 1),
      parentSpanId: rootSpanId,
      name: "embed.batch",
      kind: 1,
      startTimeUnixNano: nanos(input.startedAt, Math.max(0, input.durationMs - input.embedding.durationMs)),
      endTimeUnixNano: nanos(input.startedAt, input.durationMs),
      attributes: [
        ...attr("langfuse.observation.type", "embedding"),
        ...common,
        ...attr("langfuse.observation.model.name", input.embedding.model),
        ...attr("langfuse.observation.metadata.dimensions", input.embedding.dimensions),
        ...attr("langfuse.observation.metadata.total", input.embedding.total),
        ...attr("langfuse.observation.metadata.embedded", input.embedding.embedded),
        ...attr("langfuse.observation.metadata.skipped", input.embedding.skipped),
      ],
    });
  }
  return { resourceSpans: [{ resource: { attributes: Object.entries(options.resource).flatMap(([key, value]) => attr(key, value)) }, scopeSpans: [{ scope: { name: "ketchupe-index" }, spans }] }] };
}

function scoreTrace(score: Score, resource: Record<string, string>, environment: string): unknown {
  const timestamp = new Date().toISOString();
  const idValue = score.id ?? randomUUID();
  return { resourceSpans: [{ resource: { attributes: Object.entries(resource).flatMap(([key, value]) => attr(key, value)) }, scopeSpans: [{ scope: { name: "ketchupe-feedback" }, spans: [{
    traceId: score.traceId,
    spanId: spanIdFor(idValue, 0),
    parentSpanId: score.parentSpanId,
    name: `feedback.${score.name.replaceAll("/", ".")}`,
    kind: 1,
    startTimeUnixNano: nanos(timestamp),
    endTimeUnixNano: nanos(timestamp, 1),
    attributes: [
      ...attr("langfuse.observation.type", "evaluator"),
      ...attr("langfuse.environment", environment),
      ...attr("langfuse.observation.metadata.scoreName", score.name),
      ...attr("langfuse.observation.metadata.scoreValue", score.value),
      ...attr("langfuse.observation.metadata.scoreDataType", score.dataType),
      ...attr("langfuse.observation.metadata.scoreProvenance", score.name.startsWith("user/") ? "user" : "runtime"),
      ...attr("langfuse.observation.metadata.scorerVersion", TRAJECTORY_SCHEMA_VERSION),
      ...attr("langfuse.observation.output", score.comment),
    ],
  }] }] }] };
}

export type TelemetryIdentity = { installId: string; appVersion: string; os: string };
type OutboxRow = { id: string; kind: "run" | "trace" | "score"; run_id: string | null; payload: string | null; attempts: number };
type FlushResult = { traces: number; scores: number; error?: string };

export class LangfuseExporter {
  private timer?: ReturnType<typeof setTimeout>;
  private flushing?: Promise<FlushResult>;
  private stopped = false;
  private readonly db: DatabaseSync;
  private readonly settings: () => TelemetrySettings;
  private readonly identity: TelemetryIdentity;
  private readonly log: (message: string) => void;

  constructor(db: DatabaseSync, settings: () => TelemetrySettings, identity: TelemetryIdentity, log: (message: string) => void = console.warn) {
    this.db = db;
    this.settings = settings;
    this.identity = identity;
    this.log = log;
    if (this.enabled && this.hasReadyItems()) this.schedule();
  }

  get enabled(): boolean {
    return Boolean(this.settings().endpoint);
  }

  userId(): string {
    return `install:${hmac(this.identity.installId, "ketchupe-user")}`;
  }

  resource(): Record<string, string> {
    const memoryGiB = Math.max(1, Math.round(totalmem() / 1024 ** 3));
    return {
      "service.name": "ketchupe",
      "service.version": this.identity.appVersion,
      "os.type": this.identity.os,
      "os.arch": arch(),
      "host.cpu.count": String(cpus().length),
      "host.memory.bucket_gib": String(2 ** Math.ceil(Math.log2(memoryGiB))),
      "ketchupe.install_hmac": hmac(this.identity.installId, "ketchupe-install"),
      "ketchupe.embedding_backend": process.env.TOMATO_EMBEDDING_BACKEND || "onnx-auto",
    };
  }

  private traceOptions() {
    const settings = this.settings();
    return {
      userId: this.userId(),
      identityKey: this.identity.installId,
      contentMode: settings.contentMode,
      environment: settings.environment,
      tenantId: settings.tenantId,
      resource: this.resource(),
    };
  }

  /** One trace per app launch so DAU/MAU can be read from Langfuse users even on days without runs. */
  appSession(variant: string): void {
    if (!this.enabled) return;
    const id = randomUUID();
    const now = new Date().toISOString();
    this.enqueue(`trace:${id}`, "trace", null, {
      resourceSpans: [{ resource: { attributes: Object.entries(this.resource()).flatMap(([key, value]) => attr(key, value)) }, scopeSpans: [{ scope: { name: "ketchupe-agent" }, spans: [{
        traceId: traceIdFor(id), spanId: spanIdFor(id, 0), name: "app.session", kind: 1, startTimeUnixNano: nanos(now), endTimeUnixNano: nanos(now, 1),
        attributes: [...attr("langfuse.trace.name", "app.session"), ...attr("langfuse.user.id", this.userId()), ...attr("langfuse.trace.tags", [variant, "app.session"]), ...attr("langfuse.release", this.identity.appVersion), ...attr("langfuse.environment", this.settings().environment), ...attr("langfuse.trace.metadata.trajectorySchemaVersion", TRAJECTORY_SCHEMA_VERSION), ...attr("langfuse.trace.metadata.variant", variant)],
      }] }] }],
    });
    this.schedule();
  }

  exportRun(db: DatabaseSync, runId: string): void {
    if (!this.enabled) return;
    const built = buildRunTrace(db, runId, this.traceOptions());
    if (!built) return;
    this.enqueue(`run:${runId}`, "run", runId);
    if (built.terminal) this.enqueueRunScores(runId, built.scores);
    this.schedule();
  }

  indexSync(input: IndexSyncTelemetry): void {
    if (!this.enabled) return;
    const id = randomUUID();
    this.enqueue(`trace:${id}`, "trace", null, buildIndexTrace(id, input, this.traceOptions()));
    this.schedule();
  }

  score(score: Score): void {
    if (!this.enabled) return;
    const queued = { ...score, id: score.id ?? randomUUID() };
    this.enqueue(`score:${queued.id}`, "score", null, queued);
    this.schedule();
  }

  private enqueue(id: string, kind: OutboxRow["kind"], runId: string | null, payload?: unknown): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO telemetry_outbox (id, kind, run_id, payload, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, kind, runId, payload === undefined ? null : JSON.stringify(payload), new Date().toISOString());
  }

  private enqueueRunScores(runId: string, scores: Score[]): void {
    for (const score of scores) {
      const queued = { ...score, id: score.id ?? randomUUID() };
      this.enqueue(`score:${runId}:${score.name}`, "score", runId, queued);
    }
  }

  private hasReadyItems(): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM telemetry_outbox AS outbox
      LEFT JOIN runs ON runs.id = outbox.run_id
      WHERE outbox.sent_at IS NULL
        AND (outbox.kind <> 'run' OR runs.status NOT IN ('running', 'waiting_user'))
      LIMIT 1
    `).get());
  }

  private schedule(delay = TELEMETRY_FLUSH_MS): void {
    if (this.enabled && !this.stopped) this.timer ??= setTimeout(() => void this.flush(), delay);
  }

  private headers(): Record<string, string> {
    const token = this.settings().token;
    return {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
      "x-langfuse-ingestion-version": "4",
    };
  }

  /** Sends durable outbox items. A failed item remains in SQLite and is retried with bounded backoff. */
  flush(): Promise<FlushResult> {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushOnce().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  stop(): Promise<FlushResult> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    return this.flush();
  }

  private async flushOnce(): Promise<FlushResult> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.enabled) return { traces: 0, scores: 0 };
    const rows = this.db.prepare(`
      SELECT outbox.id, outbox.kind, outbox.run_id, outbox.payload, outbox.attempts
      FROM telemetry_outbox AS outbox
      LEFT JOIN runs ON runs.id = outbox.run_id
      WHERE outbox.sent_at IS NULL
        AND (outbox.kind <> 'run' OR runs.status NOT IN ('running', 'waiting_user'))
      ORDER BY outbox.rowid
      LIMIT ?
    `).all(OUTBOX_LIMIT) as OutboxRow[];
    if (!rows.length) return { traces: 0, scores: 0 };
    const endpoint = this.settings().endpoint;
    let traces = 0;
    let scores = 0;
    let error: string | undefined;
    for (const row of rows) {
      let retryDelay = 0;
      try {
        let payload: unknown;
        if (row.kind === "run") {
          const built = buildRunTrace(this.db, row.run_id ?? "", this.traceOptions());
          if (!built?.terminal) continue;
          this.enqueueRunScores(row.run_id ?? "", built.scores);
          payload = built.payload;
        } else {
          const stored = JSON.parse(row.payload ?? "null") as Score;
          payload = row.kind === "score" ? scoreTrace(stored, this.resource(), this.settings().environment) : stored;
        }
        const response = await fetch(endpoint, { method: "POST", headers: this.headers(), body: JSON.stringify(payload), signal: AbortSignal.timeout(TELEMETRY_REQUEST_TIMEOUT_MS) });
        if (!response.ok) {
          retryDelay = retryAfterMs(response.headers.get("retry-after"));
          throw new Error(`${row.kind} ingest ${response.status}: ${(await response.text()).slice(0, 200)}`);
        }
        if (row.kind === "run") this.db.prepare("UPDATE telemetry_outbox SET sent_at = ?, last_error = NULL WHERE id = ?").run(new Date().toISOString(), row.id);
        else this.db.prepare("DELETE FROM telemetry_outbox WHERE id = ?").run(row.id);
        if (row.kind === "score") scores += 1;
        else traces += 1;
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
        const attempts = row.attempts + 1;
        this.db.prepare("UPDATE telemetry_outbox SET attempts = ?, last_error = ? WHERE id = ?").run(attempts, error, row.id);
        this.log(`[telemetry] flush failed: ${error}`);
        this.schedule(Math.max(retryDelay, Math.min(TELEMETRY_FLUSH_MS * 2 ** Math.min(attempts, 6), TELEMETRY_RETRY_MAX_MS)));
        break;
      }
    }
    if (!error && this.hasReadyItems()) this.schedule();
    return { traces, scores, error };
  }
}
