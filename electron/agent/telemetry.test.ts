// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openAgentDb } from "../db/openAgentDb.ts";
import { PIPELINE_PROFILE, Tomato } from "../tomato/tomato.ts";
import type { PolicyDecision } from "./contracts.ts";
import { Harness } from "./harness.ts";
import { createFixtureClient } from "./modelClient.ts";
import { ANSWER_PROMPT_VERSION, assignVariant, DEFAULT_POLICY_PROFILE, POLICY_VARIANTS } from "./policy.ts";
import { createThread, ensureWorkspace, recordInteraction } from "./store.ts";
import { buildRunTrace, interactionScore, LangfuseExporter, retryAfterMs, traceIdFor } from "./telemetry.ts";
import { tomatoTools } from "./tools.ts";

let temporary: string;
let runId: string;
let maruRunId: string;
const db = openAgentDb(":memory:");
const base = { taskDifficulty: 1, predictedSuccess: 0.7, evidenceSufficiency: 0.5, policyVersion: "orchestration-1" } as const;
const decisions: PolicyDecision[] = [
  { ...base, action: "SEARCH", reasonCode: "MISSING_EVIDENCE", search: { tool: "search_local_docs", query: "연차 정산" } },
  { ...base, action: "ANSWER", reasonCode: "ENOUGH_EVIDENCE" },
];

beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), "telemetry-"));
  const docs = join(temporary, "docs");
  await mkdir(docs);
  await writeFile(join(docs, "a.md"), "# 규정\n\n## 연차\n\n미사용 연차는 수당으로 정산한다.\n");
  const tomato = new Tomato(join(temporary, "home"));
  await tomato.registerCollection(docs, "work");
  const workspace = ensureWorkspace(db);
  const settled: string[] = [];
  const harness = new Harness({
    db,
    model: createFixtureClient({ decide: decisions, answer: "수당으로 정산합니다 [[e1]]" }),
    tools: tomatoTools(tomato, { mode: "keyword", topK: 8 }),
    profiles: { retrieval: PIPELINE_PROFILE, policy: DEFAULT_POLICY_PROFILE, answer: { modelAlias: "fixture", promptVersion: ANSWER_PROMPT_VERSION } },
    activeCollections: () => ["work"],
    runMetadata: () => ({ variant: "baseline-v1", corpusFingerprints: { work: "fp-work-1" } }),
    onRunSettled: (id, status) => settled.push(`${id}:${status}`),
  });
  const handle = harness.startRun({ workspaceId: workspace.id, threadId: createThread(db, workspace.id).id, text: "연차 정산?" });
  await handle.done;
  runId = handle.runId;
  expect(settled).toEqual([`${runId}:completed`]);
  recordInteraction(db, runId, "accepted");

  const maruHarness = new Harness({
    db,
    model: createFixtureClient({
      decide: [
        { ...base, action: "SEARCH", reasonCode: "MISSING_EVIDENCE", search: { tool: "browse_storage" } },
        { ...base, action: "ANSWER", reasonCode: "ENOUGH_EVIDENCE" },
      ],
      answer: "MARU 비밀 답변",
    }),
    tools: {
      ...tomatoTools(tomato, { mode: "keyword", topK: 8 }),
      maru: {
        call: async () => ({ summary: JSON.stringify({ storages: [{ name: "공유문서 비밀", storage_id: "secret-storage" }] }), documents: [] }),
        readDocument: async () => { throw new Error("not used"); },
      },
    },
    profiles: { retrieval: PIPELINE_PROFILE, policy: DEFAULT_POLICY_PROFILE, answer: { modelAlias: "fixture", promptVersion: ANSWER_PROMPT_VERSION } },
    activeCollections: () => ["work"],
  });
  const maruHandle = maruHarness.startRun({ workspaceId: workspace.id, threadId: createThread(db, workspace.id).id, text: "MARU 목록" });
  await maruHandle.done;
  maruRunId = maruHandle.runId;
});

afterAll(async () => {
  await rm(temporary, { recursive: true, force: true });
});

describe("telemetry", () => {
  it("parses Retry-After dates, seconds and invalid values without timer overflow", () => {
    const now = Date.parse("2026-10-12T00:00:00Z");
    expect(retryAfterMs("90", now)).toBe(90_000);
    expect(retryAfterMs("Mon, 12 Oct 2026 00:01:00 GMT", now)).toBe(60_000);
    expect(retryAfterMs("Sun, 11 Oct 2026 00:00:00 GMT", now)).toBe(0);
    expect(retryAfterMs("invalid", now)).toBe(0);
    expect(retryAfterMs(null, now)).toBe(0);
    expect(retryAfterMs("999999999", now)).toBe(2_147_483_647);
  });

  it("bounds telemetry requests and schedules throttled items after Retry-After", async () => {
    const originalFetch = globalThis.fetch;
    let signal: AbortSignal | undefined;
    const timer = vi.spyOn(globalThis, "setTimeout");
    const exporter = new LangfuseExporter(
      db,
      () => ({ endpoint: "https://collector.test/v1/traces", contentMode: "ops", environment: "test", tenantId: "test", variant: "" }),
      { installId: "inst", appVersion: "3.0.0", os: "darwin" },
      () => undefined,
    );
    try {
      globalThis.fetch = (async (_url, init) => {
        signal = init?.signal as AbortSignal;
        return new Response("busy", { status: 429, headers: { "retry-after": "90" } });
      }) as typeof fetch;
      exporter.score(interactionScore(runId, "corrected"));
      expect((await exporter.flush()).error).toContain("429");
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(timer).toHaveBeenLastCalledWith(expect.any(Function), 90_000);
      expect(db.prepare("SELECT attempts FROM telemetry_outbox WHERE kind = 'score'").get()).toMatchObject({ attempts: 1 });
    } finally {
      globalThis.fetch = (async () => new Response("{}")) as typeof fetch;
      await exporter.stop();
      globalThis.fetch = originalFetch;
      timer.mockRestore();
    }
  });

  it("maps a run to one OTLP trace with step, tool, and generation spans, redacted by default", () => {
    const built = buildRunTrace(db, runId, { userId: "install:test", identityKey: "local-secret", contentMode: "ops", environment: "test", tenantId: "test", resource: { "service.name": "ketchupe" } });
    expect(built).toBeDefined();
    const spans = (built!.payload as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ name: string; traceId: string; spanId: string; parentSpanId?: string; attributes: Array<{ key: string; value: Record<string, unknown> }> }> }> }> }).resourceSpans[0].scopeSpans[0].spans;
    expect(built!.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(spans.every((span) => span.traceId === built!.traceId && /^[0-9a-f]{16}$/.test(span.spanId))).toBe(true);
    expect(spans.map((span) => span.name)).toEqual(["agent.run", "policy.step.1", "policy.step.2", "model.policy", "tool.search_local_docs", "model.policy", "model.answer", "agent.time_to_first_token"]);
    const generation = spans.find((span) => span.name === "model.answer");
    const firstToken = generation?.attributes.find((item) => item.key === "langfuse.observation.completion_start_time")?.value as { stringValue: string };
    const wait = spans.at(-1) as unknown as { startTimeUnixNano: string; endTimeUnixNano: string };
    expect(wait.endTimeUnixNano).toBe(`${Date.parse(firstToken.stringValue) * 1_000_000}`);
    expect(Number(wait.endTimeUnixNano)).toBeGreaterThanOrEqual(Number(wait.startTimeUnixNano));
    const root = spans[0];
    const value = (key: string) => root.attributes.find((item) => item.key === key)?.value;
    expect(value("langfuse.user.id")).toEqual({ stringValue: "install:test" });
    expect(value("langfuse.trace.tags")).toEqual({ arrayValue: { values: [{ stringValue: "baseline-v1" }, { stringValue: "completed" }] } });
    expect(value("langfuse.trace.metadata.variant")).toEqual({ stringValue: "baseline-v1" });
    expect(value("langfuse.trace.metadata.actions")).toEqual({ stringValue: "SEARCH>ANSWER" });
    expect(value("langfuse.trace.metadata.corpusFingerprints")).toEqual({ stringValue: JSON.stringify(["fp-work-1"]) });
    expect((value("langfuse.observation.input") as { stringValue: string }).stringValue).toMatch(/^hmac-sha256:/);
    expect(JSON.stringify(built!.payload)).not.toContain("연차");
    expect(spans.every((span) => span.attributes.some((item) => item.key === "langfuse.trace.metadata.trajectorySchemaVersion"))).toBe(true);
    expect(spans.find((span) => span.name === "tool.search_local_docs")?.parentSpanId).toBe(spans[1].spanId);
    expect(built!.scores.map((score) => score.name)).toEqual(["runtime/completed", "runtime/citation_valid", "agent/predicted_success", "runtime/steps", "runtime/searches"]);
  });

  it("includes content only for the service-selected internal mode", () => {
    const built = buildRunTrace(db, runId, { userId: "u", identityKey: "key", contentMode: "internal_full", environment: "test", tenantId: "test", resource: {} });
    expect(JSON.stringify(built!.payload)).toContain("연차 정산?");
    expect(JSON.stringify(built!.payload)).toContain("미사용 연차는 수당으로 정산한다.");
    expect(JSON.stringify(built!.payload)).not.toContain(temporary);
  });

  it("never exports MARU content, even in internal mode", () => {
    const built = buildRunTrace(db, maruRunId, { userId: "u", identityKey: "key", contentMode: "internal_full", environment: "test", tenantId: "test", resource: {} });
    const payload = JSON.stringify(built!.payload);
    expect(payload).toContain("[MARU_RESULT_OMITTED]");
    expect(payload).toContain("browse_storage");
    expect(payload).not.toContain("공유문서 비밀");
    expect(payload).not.toContain("MARU 비밀 답변");
    expect(payload).not.toContain("secret-storage");
  });

  it("turns interactions into scores on the same trace id", () => {
    expect(interactionScore(runId, "accepted")).toMatchObject({ traceId: traceIdFor(runId), name: "user/user_feedback", value: 1, dataType: "BOOLEAN" });
    expect(interactionScore(runId, "corrected").value).toBe(0);
  });

  it("assigns variants deterministically and honours overrides", () => {
    const names = Object.keys(POLICY_VARIANTS);
    expect(assignVariant("install-a")).toBe(assignVariant("install-a"));
    expect(names).toContain(assignVariant("install-a"));
    expect(assignVariant("install-a", "adaptive-v1")).toBe("adaptive-v1");
    expect(assignVariant("install-a", "nope")).toBe(assignVariant("install-a"));
  });

  it("posts traces and evaluator spans to the single OTLP gateway", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body: String(init?.body) });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const exporter = new LangfuseExporter(db, () => ({ endpoint: "https://collector.test/v1/traces", token: "public-ingest", contentMode: "ops", environment: "test", tenantId: "test", variant: "" }), { installId: "inst", appVersion: "3.0.0", os: "darwin" });
      exporter.exportRun(db, runId);
      exporter.score(interactionScore(runId, "accepted"));
      const result = await exporter.flush();
      expect(result).toEqual({ traces: 1, scores: 6 });
      expect(calls.every((call) => call.url === "https://collector.test/v1/traces")).toBe(true);
      expect(calls[0].headers.Authorization).toBe("Bearer public-ingest");
      expect(calls[0].headers["x-langfuse-ingestion-version"]).toBe("4");
      expect(calls).toHaveLength(7);
      expect(exporter.userId()).toMatch(/^install:hmac-sha256:/);
      expect(exporter.userId()).not.toBe("install:inst");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps failed telemetry in SQLite and retries it", async () => {
    const originalFetch = globalThis.fetch;
    let unavailable = true;
    globalThis.fetch = (async () => unavailable ? new Response("down", { status: 503 }) : new Response("{}", { status: 200 })) as typeof fetch;
    try {
      const exporter = new LangfuseExporter(
        db,
        () => ({ endpoint: "https://collector.test/v1/traces", contentMode: "ops", environment: "test", tenantId: "test", variant: "" }),
        { installId: "inst", appVersion: "3.0.0", os: "darwin" },
        () => undefined,
      );
      exporter.score(interactionScore(runId, "retried"));
      expect((await exporter.flush()).error).toContain("503");
      expect((db.prepare("SELECT COUNT(*) AS count FROM telemetry_outbox WHERE kind = 'score'").get() as { count: number }).count).toBe(1);

      unavailable = false;
      const restarted = new LangfuseExporter(
        db,
        () => ({ endpoint: "https://collector.test/v1/traces", contentMode: "ops", environment: "test", tenantId: "test", variant: "" }),
        { installId: "inst", appVersion: "3.0.0", os: "darwin" },
        () => undefined,
      );
      expect(await restarted.flush()).toEqual({ traces: 0, scores: 1, error: undefined });
      await exporter.flush(); // clears the first instance's scheduled retry
      expect((db.prepare("SELECT COUNT(*) AS count FROM telemetry_outbox WHERE kind = 'score'").get() as { count: number }).count).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("emits collection indexing and embedding as an OTLP trace", async () => {
    const bodies: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const exporter = new LangfuseExporter(db, () => ({ endpoint: "https://collector.test/v1/traces", contentMode: "ops", environment: "test", tenantId: "test", variant: "" }), { installId: "inst", appVersion: "3.0.0", os: "darwin" });
      exporter.indexSync({
        collection: "work",
        startedAt: new Date().toISOString(),
        durationMs: 20,
        report: { collection: "work", scanned: 2, updated: 1, unchanged: 1, removed: 0, failed: [], pipelineFingerprint: "pipeline-sha" },
        embedding: { collection: "work", total: 4, embedded: 2, skipped: 2, model: "e5", dimensions: 384, durationMs: 10 },
      });
      expect(await exporter.flush()).toEqual({ traces: 1, scores: 0, error: undefined });
      expect(bodies[0]).toContain("index.sync");
      expect(bodies[0]).toContain("embed.batch");
      expect(bodies[0]).not.toContain("\"work\"");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does nothing when disabled", async () => {
    const exporter = new LangfuseExporter(db, () => ({ endpoint: "", contentMode: "ops", environment: "test", tenantId: "test", variant: "" }), { installId: "i", appVersion: "0", os: "darwin" });
    exporter.exportRun(db, runId);
    expect(await exporter.flush()).toEqual({ traces: 0, scores: 0 });
  });
});
