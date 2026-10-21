// @vitest-environment node
import { describe, expect, it } from "vitest";
import { validateDecision, type PolicyState } from "./contracts.ts";

const state: PolicyState = {
  runId: "r1",
  step: 1,
  userGoal: "q",
  selectedMemories: [],
  activeCollections: ["work"],
  recentMessages: [],
  evidence: [{ evidenceId: "e1", sourceId: "s", chunkId: "c", title: "t", breadcrumb: [], locator: {}, snippet: "x", score: 1 }],
  previousDecisions: [],
  remaining: { steps: 3, modelCalls: 3, searches: 1, verifies: 0, wallTimeMs: 1000 },
};

const base = { taskDifficulty: 1, predictedSuccess: 0.8, evidenceSufficiency: 0.2, reasonCode: "MISSING_EVIDENCE", policyVersion: "orchestration-1" } as const;

describe("validateDecision", () => {
  it("allows Trolley discovery only when configured and rejects execution tools", () => {
    const decision = { ...base, action: "SEARCH", search: { tool: "get_my_capabilities" } };
    expect(validateDecision(decision, state)).toMatchObject({ ok: false, code: "INVALID_DECISION" });
    expect(validateDecision(decision, { ...state, trolleyAvailable: true }).ok).toBe(true);
    expect(validateDecision({ ...decision, search: { tool: "list_operations" } }, { ...state, trolleyAvailable: true }).ok).toBe(true);
    expect(validateDecision({ ...decision, search: { tool: "execute" } }, { ...state, trolleyAvailable: true }).ok).toBe(false);
    expect(validateDecision(decision, { ...state, trolleyAvailable: true, remaining: { ...state.remaining, searches: 0 } })).toMatchObject({ ok: false, code: "BUDGET_EXCEEDED" });
  });

  it("accepts a valid search", () => {
    const result = validateDecision({ ...base, action: "SEARCH", search: { tool: "search_local_docs", query: "연차" } }, state);
    expect(result.ok).toBe(true);
  });
  it("rejects probability out of range", () => {
    const result = validateDecision({ ...base, action: "ANSWER", predictedSuccess: 1.2 }, state);
    expect(result).toMatchObject({ ok: false, code: "INVALID_DECISION" });
  });
  it("requires action-specific fields", () => {
    expect(validateDecision({ ...base, action: "ASK" }, state).ok).toBe(false);
    expect(validateDecision({ ...base, action: "STOP" }, state).ok).toBe(false);
    expect(validateDecision({ ...base, action: "SEARCH", search: { tool: "get_document_context", evidenceId: "nope" } }, state).ok).toBe(false);
    expect(validateDecision({ ...base, action: "SEARCH", search: { tool: "get_document_context", evidenceId: "e1" } }, state).ok).toBe(true);
  });
  it("enforces budget over the model", () => {
    const result = validateDecision({ ...base, action: "VERIFY", claimsToVerify: ["a"] }, state);
    expect(result).toMatchObject({ ok: false, code: "BUDGET_EXCEEDED" });
    const noSearch = validateDecision({ ...base, action: "SEARCH", search: { tool: "search_local_docs", query: "x" } }, { ...state, remaining: { ...state.remaining, searches: 0 } });
    expect(noSearch).toMatchObject({ ok: false, code: "BUDGET_EXCEEDED" });
    const noAnswerCall = validateDecision({ ...base, action: "ANSWER" }, { ...state, remaining: { ...state.remaining, modelCalls: 0 } });
    expect(noAnswerCall).toMatchObject({ ok: false, code: "BUDGET_EXCEEDED" });
  });
  it("enforces the profile's action set", () => {
    const result = validateDecision({ ...base, action: "ASK", question: "어떤 휴가인가요?" }, state, ["SEARCH", "ANSWER", "STOP"]);
    expect(result).toMatchObject({ ok: false, code: "INVALID_DECISION" });
  });
  it("validates MARU availability and find arguments", () => {
    const enabled = {
      ...state,
      maruAvailable: true,
      externalDocuments: [{ refId: "doc1", provider: "maru" as const, storageId: "s1", path: "report.md" }],
    };
    expect(validateDecision({ ...base, action: "SEARCH", search: { tool: "browse_storage" } }, state).ok).toBe(false);
    expect(validateDecision({ ...base, action: "SEARCH", search: { tool: "browse_storage" } }, enabled).ok).toBe(true);
    expect(validateDecision({ ...base, action: "SEARCH", search: { tool: "find_storage", arguments: {} } }, enabled).ok).toBe(false);
    expect(validateDecision({ ...base, action: "SEARCH", search: { tool: "find_storage", arguments: { storage_id: "s1", file_path: "report.md" } } }, enabled).ok).toBe(true);
    expect(validateDecision({ ...base, action: "SEARCH", search: { tool: "read_external_document", ref_id: "missing" } }, enabled).ok).toBe(false);
    expect(validateDecision({ ...base, action: "SEARCH", search: { tool: "read_external_document", ref_id: "doc1" } }, enabled).ok).toBe(true);
  });
});

describe("normalizeBaseURL", async () => {
  const { normalizeBaseURL } = await import("./modelClient.ts");
  it("accepts a bare domain, a URL, or a URL that already has /v1", () => {
    expect(normalizeBaseURL("centinels.ml2-alpha.com")).toBe("https://centinels.ml2-alpha.com/v1/");
    expect(normalizeBaseURL("https://centinels.ml2-alpha.com/")).toBe("https://centinels.ml2-alpha.com/v1/");
    expect(normalizeBaseURL("https://centinels.ml2-alpha.com/v1")).toBe("https://centinels.ml2-alpha.com/v1/");
    expect(normalizeBaseURL("http://localhost:4000/proxy/v1/")).toBe("http://localhost:4000/proxy/v1/");
    expect(normalizeBaseURL("")).toBe("https://centinels.ml2-alpha.com/v1/");
  });
});
