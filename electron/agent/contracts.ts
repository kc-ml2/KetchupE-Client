import { z } from "zod";

export type AgentErrorCode =
  | "MODEL_AUTH"
  | "MODEL_TIMEOUT"
  | "MODEL_PROTOCOL"
  | "INVALID_DECISION"
  | "TOOL_TIMEOUT"
  | "TOOL_UNAVAILABLE"
  | "BUDGET_EXCEEDED"
  | "INVALID_CITATION"
  | "CANCELLED"
  | "INTERNAL";

export class AgentError extends Error {
  readonly code: AgentErrorCode;
  constructor(code: AgentErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export const POLICY_ACTIONS = ["SEARCH", "ASK", "VERIFY", "ANSWER", "STOP"] as const;
export type PolicyAction = (typeof POLICY_ACTIONS)[number];

export const POLICY_STRATEGIES = ["llm", "always-search", "gated"] as const;
export type PolicyStrategy = (typeof POLICY_STRATEGIES)[number];

export const REASON_CODES = [
  "NO_RETRIEVAL_NEEDED",
  "MISSING_EVIDENCE",
  "QUERY_REWRITE",
  "NEED_NEIGHBORS",
  "MISSING_USER_INPUT",
  "CONFLICTING_EVIDENCE",
  "ENOUGH_EVIDENCE",
  "UNSUPPORTED",
  "BUDGET_LIMIT",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export type Locator = {
  pageStart?: number;
  pageEnd?: number;
  sheet?: string;
  cellRange?: string;
  blockRange?: [number, number];
  bbox?: [number, number, number, number];
};

export const EVIDENCE_SNIPPET_MAX_CHARS = 400;

export type Evidence = {
  evidenceId: string;
  sourceId: string;
  chunkId: string;
  title: string;
  breadcrumb: string[];
  locator: Locator;
  snippet: string;
  score: number;
};

export type MemoryKind = "preference" | "fact" | "task";

export type SelectedMemory = { id: string; kind: MemoryKind; content: string };

export type ExternalDocumentRef = {
  refId: string;
  provider: "maru";
  storageId: string;
  storageName?: string;
  path: string;
  size?: number;
  modifiedAt?: string;
};

export type Observation =
  | { kind: "search"; resultIds: string[]; effectiveMode: "keyword" | "semantic" | "hybrid"; latencyMs: number }
  | { kind: "external"; tool: "browse_storage" | "find_storage" | "get_my_capabilities" | "list_operations"; result: string; latencyMs: number }
  | { kind: "user"; messageId: string }
  | { kind: "verification"; supported: boolean; missingClaims: string[]; confidence: number }
  | { kind: "tool_error"; code: AgentErrorCode };

export type Budget = {
  steps: number;
  modelCalls: number;
  searches: number;
  verifies: number;
  wallTimeMs: number;
};

export type PolicyState = {
  runId: string;
  step: number;
  userGoal: string;
  selectedMemories: SelectedMemory[];
  activeCollections: string[];
  maruAvailable?: boolean;
  trolleyAvailable?: boolean;
  externalDocuments?: ExternalDocumentRef[];
  recentMessages: Array<{ role: "user" | "assistant"; content: string }>;
  evidence: Evidence[];
  signals?: {
    evidenceCount: number;
    uniqueSourceCount: number;
    topEvidenceScore: number;
    lastSearchResultCount?: number;
    lastVerificationSupported?: boolean;
  };
  previousDecisions: PolicyAction[];
  lastObservation?: Observation;
  remaining: Budget;
};

const probability = z.number().min(0).max(1);

const nullableString = z.string().nullable().optional();
const browseStorageArguments = z.object({
  storage_id: nullableString,
  path: z.string().optional(),
  max_depth: z.number().int().nonnegative().optional(),
  max_results: z.number().int().positive().optional(),
}).optional();
const findStorageArguments = z.object({
  query: nullableString,
  storage_id: nullableString,
  file_path: nullableString,
  extensions: z.array(z.string()).nullable().optional(),
  modified_from: nullableString,
  modified_before: nullableString,
  min_size_bytes: z.number().int().nonnegative().nullable().optional(),
  max_size_bytes: z.number().int().nonnegative().nullable().optional(),
  search_in: z.enum(["filename", "content", "both"]).optional(),
  path: z.string().optional(),
  case_sensitive: z.boolean().optional(),
  include_globs: z.array(z.string()).nullable().optional(),
  exclude_globs: z.array(z.string()).nullable().optional(),
  max_results: z.number().int().positive().optional(),
});

const searchDecision = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("search_local_docs"), query: z.string(), evidenceId: z.string().optional() }),
  z.object({ tool: z.literal("get_document_context"), query: z.string().optional(), evidenceId: z.string() }),
  z.object({ tool: z.literal("browse_storage"), arguments: browseStorageArguments }),
  z.object({ tool: z.literal("find_storage"), arguments: findStorageArguments }),
  z.object({ tool: z.literal("read_external_document"), ref_id: z.string(), query: z.string().optional() }),
  z.object({ tool: z.literal("get_my_capabilities") }),
  z.object({ tool: z.literal("list_operations") }),
]);

export const PolicyDecisionSchema = z.object({
  action: z.enum(POLICY_ACTIONS),
  taskDifficulty: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  predictedSuccess: probability,
  evidenceSufficiency: probability,
  reasonCode: z.enum(REASON_CODES),
  search: searchDecision.optional(),
  question: z.string().optional(),
  claimsToVerify: z.array(z.string()).optional(),
  stopReason: z.string().optional(),
  policyVersion: z.string(),
});
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export const VerificationResultSchema = z.object({
  supported: z.boolean(),
  missingClaims: z.array(z.string()),
  confidence: probability,
});
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

export type RunOutcome = "success" | "failure" | "abstained" | "waiting_user";

export type PolicyTransition = {
  state: PolicyState;
  decision: PolicyDecision;
  observation?: Observation;
  outcome?: RunOutcome;
  reward?: number;
};

export type PolicyProfile = {
  version: string;
  strategy: PolicyStrategy;
  allowedActions: PolicyAction[];
  modelAlias: string;
  promptVersion: string;
  maxSteps: number;
  maxModelCalls: number;
  maxSearchCalls: number;
  maxVerifyCalls: number;
  runTimeoutMs: number;
};

export type VerifyInput = { userGoal: string; claims: string[]; evidence: Evidence[] };

export type AnswerInput = { userGoal: string; context: string; evidence: Evidence[] };

export type AnswerEvent =
  | { type: "text_delta"; text: string }
  | { type: "completed"; promptTokens: number; completionTokens: number };

export const LIMITS = {
  maxSteps: 6,
  maxModelCalls: 8,
  maxSearchCalls: 3,
  maxVerifyCalls: 1,
  maxEvidence: 12,
  runTimeoutMs: 180_000,
  toolTimeoutMs: 30_000,
  /** Characters of chunk text shown to the policy/answer model per evidence item. Tables and long 항 lists get cut here. */
  evidenceSnippetChars: EVIDENCE_SNIPPET_MAX_CHARS,
} as const;

export type TraceStage =
  | "input"
  | "context"
  | "policy"
  | "retrieval"
  | "verification"
  | "generation"
  | "citation"
  | "runtime"
  | "feedback";

export type TraceEventType =
  | "run.started"
  | "context.selected"
  | "policy.decided"
  | "tool.started"
  | "tool.completed"
  | "model.started"
  | "model.completed"
  | "verification.completed"
  | "answer.validated"
  | "run.waiting_user"
  | "run.completed"
  | "run.failed"
  | "interaction.recorded"
  | "canvas.updated";

export type TraceEvent = {
  runId: string;
  seq: number;
  parentSeq?: number;
  type: TraceEventType;
  stage: TraceStage;
  startedAt: string;
  durationMs?: number;
  payload: Record<string, unknown>;
};

export type InteractionKind =
  | "accepted"
  | "retried"
  | "corrected"
  | "citation_opened"
  | "clarification_answered"
  | "abandoned"
  | "memory_confirmed"
  | "memory_rejected";

export type DecisionValidation =
  | { ok: true; decision: PolicyDecision }
  | { ok: false; code: "INVALID_DECISION" | "BUDGET_EXCEEDED"; reason: string };

const invalid = (reason: string): DecisionValidation => ({ ok: false, code: "INVALID_DECISION", reason });
const overBudget = (reason: string): DecisionValidation => ({ ok: false, code: "BUDGET_EXCEEDED", reason });

/** Schema, action-specific required fields, and budget. Budget wins over the model. */
export function validateDecision(raw: unknown, state: PolicyState, allowedActions: readonly PolicyAction[] = POLICY_ACTIONS): DecisionValidation {
  const parsed = PolicyDecisionSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  const decision = parsed.data;
  if (state.remaining.steps <= 0) return overBudget("no steps remaining");
  if (!allowedActions.includes(decision.action)) return invalid(`${decision.action} is disabled by the policy profile`);

  switch (decision.action) {
    case "SEARCH": {
      if (state.remaining.searches <= 0) return overBudget("no searches remaining");
      if (!decision.search) return invalid("SEARCH requires search");
      if (decision.search.tool === "search_local_docs" && !decision.search.query?.trim()) return invalid("search_local_docs requires query");
      if (decision.search.tool === "get_document_context") {
        const evidenceId = decision.search.evidenceId;
        const known = state.evidence.some((item) => item.evidenceId === evidenceId);
        if (!known) return invalid("get_document_context requires an existing evidenceId");
      }
      if (decision.search.tool === "browse_storage" || decision.search.tool === "find_storage") {
        if (!state.maruAvailable) return invalid("MARU is not configured");
        if (decision.search.tool === "find_storage") {
          const args = decision.search.arguments;
          const hasQuery = Boolean(args.query?.trim());
          const hasExactFile = Boolean(args.storage_id?.trim() && args.file_path?.trim());
          if (!hasQuery && !hasExactFile) return invalid("find_storage requires query or storage_id with file_path");
          if (args.min_size_bytes != null && args.max_size_bytes != null && args.min_size_bytes > args.max_size_bytes) {
            return invalid("find_storage min_size_bytes cannot exceed max_size_bytes");
          }
        }
      }
      if (decision.search.tool === "read_external_document") {
        if (!state.maruAvailable) return invalid("MARU is not configured");
        const refId = decision.search.ref_id;
        if (!state.externalDocuments?.some((document) => document.refId === refId)) {
          return invalid("read_external_document requires a known ref_id");
        }
      }
      if ((decision.search.tool === "get_my_capabilities" || decision.search.tool === "list_operations") && !state.trolleyAvailable) {
        return invalid("Trolley is not configured");
      }
      break;
    }
    case "ASK":
      if (!decision.question?.trim()) return invalid("ASK requires question");
      break;
    case "VERIFY":
      if (state.remaining.modelCalls <= 0) return overBudget("no model calls remaining for verification");
      if (state.remaining.verifies <= 0) return overBudget("no verifies remaining");
      if (!decision.claimsToVerify?.length) return invalid("VERIFY requires claimsToVerify");
      if (!state.evidence.length) return invalid("VERIFY requires evidence");
      break;
    case "STOP":
      if (!decision.stopReason?.trim()) return invalid("STOP requires stopReason");
      break;
    case "ANSWER":
      if (state.remaining.modelCalls <= 0) return overBudget("no model calls remaining for answer generation");
      break;
  }
  return { ok: true, decision };
}
