import { BusinessFlow } from "../business/flow.ts";
import { businessTools } from "../business/registry.ts";
import { executeBusinessJob } from "../business/workerClient.ts";
import { readWorkbookJob } from "../work/reader.ts";
import { createHash } from "node:crypto";
import type { AccountCredentials } from "../auth/storage.ts";
import { accountId } from "../auth/storage.ts";
import { assertPublicSources } from "../auth/sourcePaths.ts";
import { AgentError } from "./contracts.ts";
import { dirname } from "node:path";
import { WorkSourcesFlow, WORK_SOURCES_ROUTE } from "./workSourcesFlow.ts";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AgentStreamEvent, CollectionSummary } from "../../src/app-types/Agent.types.ts";
import { CollectionWatchers } from "../collectionWatchers.ts";
import { openAgentDb } from "../db/openAgentDb.ts";
import { PIPELINE_PROFILE, type Collection } from "../tomato/tomato.ts";
import { TomatoClient } from "../tomato/tomatoClient.ts";
import { Harness } from "./harness.ts";
import { CanvasFlow } from "./canvas/flow.ts";
import { CHAT_ROUTE, DOC_ROUTE, routeMessage } from "./router.ts";
import type { StartRunInput, StartRunResult } from "../../src/app-types/Agent.types.ts";
import { WorkflowDispatcher } from "./workflows.ts";
import { tomatoTools } from "./tools.ts";
import { settingsBackedModelClient } from "./liveModelClient.ts";
import { listModels, resolveModelAlias } from "./modelClient.ts";
import { ANSWER_PROMPT_VERSION, assignVariant, POLICY_VARIANTS } from "./policy.ts";
import { accountModelSettings, loadTelemetrySettings, type ModelSettings } from "./settings.ts";
import { interactionScore, LangfuseExporter, loadInstallId } from "./telemetry.ts";
import type { InteractionKind } from "../../src/app-types/Agent.types.ts";
import { ensureWorkspace, inactiveCollections, recentMessages, getRunAction } from "./store.ts";
import { MaruClient } from "./maru.ts";
import { MaruAccess } from "./maruAccess.ts";
import { DEFAULT_TROLLEY_ENDPOINT, TrolleyClient } from "./trolley.ts";

export const DEFAULT_RETRIEVAL = { mode: "hybrid", topK: 8 } as const;

export type AgentRuntime = {
  db: DatabaseSync;
  tomato: TomatoClient;
  watchers: CollectionWatchers;
  canvas: CanvasFlow;
  workSourcesFlow: WorkSourcesFlow;
  businessFlow: BusinessFlow;
  /** Routes new messages to registered workflows; replies resume their persisted owner. */
  startMessage: (input: StartRunInput) => Promise<StartRunResult>;
  resumeRun: (runId: string, text: string) => void;
  cancelRun: (runId: string) => void;
  collections: () => Collection[];
  refreshCollections: () => Promise<Collection[]>;
  collectionSummaries: (workspaceId: string) => Promise<CollectionSummary[]>;
  settings: () => ModelSettings;
  /** Development builds may switch the generation model; credentials always come from the account. */
  modelSelectable: boolean;
  updateSettings: (settings: { modelAlias: string }) => void;
  listModels: () => Promise<string[]>;
  resolvedModelAlias: () => Promise<string>;
  telemetry: LangfuseExporter;
  variant: string;
  variants: string[];
  recordInteractionScore: (runId: string, kind: InteractionKind) => void;
  quiesce: () => void;
  authorizeThread: (threadId: string) => Promise<void>;
  sourcePath: (path: string) => Promise<string>;
  assertSourcePaths: (paths: string[]) => Promise<void>;
  stop: () => Promise<void>;
};

export type RuntimeOptions = {
  account: AccountCredentials;
  privateRoot: string;
  userData: string;
  workerPath: string;
  appVersion: string;
  emitAgentEvent: (event: AgentStreamEvent) => void;
  emitCollectionsChanged: () => void;
  modelSelectable?: boolean;
};

export function startAgentRuntime(options: RuntimeOptions): AgentRuntime {
  const db = openAgentDb(join(options.userData, "agent.sqlite"));
  ensureWorkspace(db);
  const tomato = new TomatoClient(options.workerPath, join(options.userData, "tomato"));
  const lifetime = new AbortController();
  let stopped = false;
  let draining: Promise<unknown> | undefined;
  let current = accountModelSettings(options.account.keys);
  const telemetrySettings = loadTelemetrySettings();
  const installId = loadInstallId(options.userData);
  // Variant is fixed for the process lifetime so every run in a session lands in one arm.
  const variant = assignVariant(installId, telemetrySettings.variant);
  const policyProfile = POLICY_VARIANTS[variant];
  const telemetry = new LangfuseExporter(db, () => telemetrySettings, { installId, accountId: accountId(options.account.email), appVersion: options.appVersion, os: process.platform });
  let collections: Collection[] = [];
  let aliasCache: { key: string; alias: string } | undefined;
  const resolvedModelAlias = async () => {
    const key = `${current.baseURL}\u0000${current.modelAlias}\u0000${current.apiKey ?? ""}`;
    if (aliasCache?.key !== key) aliasCache = { key, alias: await resolveModelAlias(current.baseURL, current.apiKey ?? "", current.modelAlias) };
    return aliasCache.alias;
  };

  // Content fingerprint per collection: lets the external benchmark match a trajectory to a corpus it also holds.
  const corpusFingerprints: Record<string, string> = {};
  const refreshFingerprint = async (name: string) => {
    try {
      corpusFingerprints[name] = await tomato.collectionFingerprint(name);
    } catch (error) {
      console.warn(`[agent] corpus fingerprint failed for ${name}:`, error);
    }
  };
  const watchers = new CollectionWatchers(tomato, () => options.emitCollectionsChanged(), (result) => {
    if (stopped) return;
    telemetry.indexSync(result);
    void refreshFingerprint(result.collection);
  });
  const harnessModel = settingsBackedModelClient(() => current, resolvedModelAlias);
  const activeCollections = (workspaceId: string) => {
    const inactive = inactiveCollections(db, workspaceId);
    return collections.map((collection) => collection.name).filter((name) => !name.startsWith("maru_") && !inactive.has(name));
  };
  const onRunSettled = (runId: string) => telemetry.exportRun(db, runId);
  const maruToken = options.account.keys.maru.api_key;
  const trolleyKey = process.env.TROLLEY_API_KEY?.trim();
  const trolley = trolleyKey ? new TrolleyClient(
    trolleyKey,
    options.appVersion,
    new URL(process.env.TROLLEY_MCP_ENDPOINT?.trim() || DEFAULT_TROLLEY_ENDPOINT.href),
  ) : undefined;
  const maru = new MaruClient(
    maruToken,
    options.appVersion,
    join(options.userData, "mcp-cache", "maru"),
    tomato,
    new URL(options.account.keys.maru.base_url),
    (document, localPath) => {
      lifetime.signal.throwIfAborted();
      db.prepare("UPDATE maru_documents SET local_path = ? WHERE ref_id = ?").run(localPath, document.refId);
    },
  );
  const maruAccess = new MaruAccess(db, maru, join(options.userData, "mcp-cache", "maru"));
  const accessSignal = () => AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]);
  const authorizeThread = (threadId: string) => maruAccess.authorizeThread(threadId, accessSignal());
  const harness = new Harness({
    db,
    model: harnessModel,
    tools: {
      ...tomatoTools(tomato, DEFAULT_RETRIEVAL),
      ...(maru ? { maru } : {}),
      ...(trolley ? { trolley } : {}),
    },
    profiles: {
      retrieval: { ...PIPELINE_PROFILE, ...DEFAULT_RETRIEVAL },
      policy: { ...policyProfile, modelAlias: current.modelAlias || "gateway-default" },
      answer: { modelAlias: current.modelAlias || "gateway-default", promptVersion: ANSWER_PROMPT_VERSION },
    },
    activeCollections,
    authorizeContext: (threadId, signal) => maruAccess.authorizeThread(threadId, AbortSignal.any([signal, accessSignal()])),
    onExternalDocuments: (threadId, documents) => maruAccess.record(threadId, documents),
    emit: options.emitAgentEvent,
    runMetadata: () => ({ variant, appVersion: options.appVersion, installId, corpusFingerprints: { ...corpusFingerprints } }),
    onRunSettled,
  });
  telemetry.appSession(variant);

  const canvas = new CanvasFlow({
    db,
    model: harnessModel,
    retrieval: {
      search: (query, names, limit) => tomato.search(query, { collections: names, mode: DEFAULT_RETRIEVAL.mode, limit }),
      getChunks: (ids) => tomato.getChunks(ids),
      listSources: (names) => tomato.listSources(names),
      getSourceChunks: (sourceId) => tomato.getSourceChunks(sourceId),
    },
    profile: { ...policyProfile, modelAlias: current.modelAlias || "gateway-default" },
    activeCollections,
    emit: options.emitAgentEvent,
    onRunSettled,
  });

  const workSourcesFlow = new WorkSourcesFlow(db, options.emitAgentEvent);
  const businessFlow = new BusinessFlow(db, businessTools.map((tool) => ({ ...tool, execute: ({ signal, ...input }) => executeBusinessJob(join(dirname(options.workerPath), "business.worker.js"), { toolId: tool.id, version: tool.version, input }, signal) })), join(options.userData, "business-output"), options.emitAgentEvent, async (bytes, sheet) => {
    await readWorkbookJob(join(dirname(options.workerPath), "workbook.worker.js"), { bytes: Buffer.from(bytes), fingerprint: createHash("sha256").update(bytes).digest("hex"), action: sheet ? { kind: "validate", sheet } : { kind: "inspect" } });
  });
  const workflows = new WorkflowDispatcher(db, [
    {
      ...CHAT_ROUTE,
      kind: "agent",
      start: (input) => harness.startRun(input),
      resume: (runId, text) => harness.resumeRun(runId, text),
      cancel: (runId) => harness.cancelRun(runId),
    },
    {
      ...DOC_ROUTE,
      kind: "canvas",
      start: (input) => canvas.start({ workspaceId: input.workspaceId, threadId: input.threadId, instruction: input.text }),
      cancel: (runId) => canvas.cancel(runId),
    },
    ...([WORK_SOURCES_ROUTE] as const).map((route) => ({
      ...route, kind: route.id,
      start: (input: StartRunInput) => workSourcesFlow.start(input, route.id as "work_sources" | "daily_cash"),
      resume: (runId: string, text: string) => workSourcesFlow.resume(runId, text),
      cancel: (runId: string) => workSourcesFlow.cancel(runId),
    })),
    ...businessFlow.workflows().map((workflow) => ({ ...workflow,
      // Preserve resumability for input requests created before the business-tool runner shipped.
      resume: (id: string, text: string) => getRunAction(db, id)?.type === "work_sources" ? workSourcesFlow.resume(id, text) : workflow.resume!(id, text),
      cancel: (id: string) => getRunAction(db, id)?.type === "work_sources" ? workSourcesFlow.cancel(id) : workflow.cancel(id),
    })),
  ], (text, routes, input) => routeMessage(
    { ...current, modelAlias: process.env.LITELLM_ROUTER_MODEL_ALIAS?.trim() || "clef-flash" },
    text,
    AbortSignal.any([lifetime.signal, AbortSignal.timeout(policyProfile.runTimeoutMs)]),
    routes,
    { recentUserMessages: recentMessages(db, input.threadId, 6).filter((message) => message.role === "user").map((message) => message.content.slice(0, 2000)) },
  ).then((route) => { lifetime.signal.throwIfAborted(); return route; }), onRunSettled);

  const refreshCollections = async () => {
    collections = (await tomato.call("listCollections", [])).filter((collection) => !collection.name.startsWith("maru_"));
    const names = new Set(collections.map((collection) => collection.name));
    for (const name of Object.keys(corpusFingerprints)) if (!names.has(name)) delete corpusFingerprints[name];
    await Promise.all(collections.filter((collection) => !corpusFingerprints[collection.name]).map((collection) => refreshFingerprint(collection.name)));
    return collections;
  };

  void refreshCollections()
    .then((list) => {
      if (stopped) return;
      watchers.start(list);
      for (const collection of list) watchers.requestSync(collection.name);
    })
    .catch(() => { if (!stopped) console.warn("[agent] tomato unavailable at startup"); });

  const quiesce = () => {
    if (stopped) return;
    stopped = true;
    lifetime.abort();
    watchers.stop();
    draining = Promise.allSettled([tomato.stop(), harness.stop(), canvas.stop(), businessFlow.stop()]);
  };

  return {
    db,
    tomato,
    watchers,
    canvas,
    workSourcesFlow,
    businessFlow,
    startMessage: async (input) => { await authorizeThread(input.threadId); lifetime.signal.throwIfAborted(); return workflows.start(input); },
    resumeRun: (runId, text) => { workflows.resume(runId, text); },
    cancelRun: (runId) => workflows.cancel(runId),
    collections: () => collections,
    refreshCollections,
    settings: () => current,
    modelSelectable: Boolean(options.modelSelectable),
    updateSettings: ({ modelAlias }) => {
      if (!options.modelSelectable) throw new AgentError("MODEL_AUTH", "연결 정보는 로그인 계정에서 관리합니다.");
      current = { ...current, modelAlias: modelAlias.trim() };
    },
    listModels: () => (current.apiKey ? listModels(current.baseURL, current.apiKey) : Promise.resolve([])),
    resolvedModelAlias,
    telemetry,
    variant,
    variants: Object.keys(POLICY_VARIANTS),
    recordInteractionScore: (runId, kind) => telemetry.score(interactionScore(runId, kind)),
    async collectionSummaries(workspaceId) {
      const inactive = inactiveCollections(db, workspaceId);
      const status = await tomato.call("status", []);
      return status.filter((item) => !item.name.startsWith("maru_")).map((item) => {
        const state = watchers.state(item.name);
        return {
          name: item.name,
          path: item.path,
          active: !inactive.has(item.name),
          sources: item.sources,
          chunks: item.chunks,
          embedded: item.embedded,
          syncing: state?.syncing ?? false,
          lastError: state?.lastError,
        };
      });
    },
    quiesce,
    authorizeThread,
    sourcePath: (path) => maruAccess.sourcePath(path, accessSignal()),
    assertSourcePaths: (paths) => assertPublicSources(options.privateRoot, paths),
    stop: async () => {
      quiesce();
      await draining;
      await maru?.close();
      await trolley?.close();
      await telemetry.stop();
      db.close();
    },
  };
}
