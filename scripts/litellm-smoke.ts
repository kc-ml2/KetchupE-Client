// Phase 0 compatibility check against the real LiteLLM gateway.
// Usage: LITELLM_API_KEY=... [LITELLM_BASE_URL=domain] [LITELLM_MODEL_ALIAS=...] node scripts/litellm-smoke.ts
import { createLiteLLMClient, resolveModelAlias, type ModelCallInfo } from "../electron/agent/modelClient.ts";
import { validateDecision, type PolicyState } from "../electron/agent/contracts.ts";
import { DEFAULT_POLICY_PROFILE, POLICY_SYSTEM } from "../electron/agent/policy.ts";

const baseURL = process.env.LITELLM_BASE_URL ?? "https://centinels.ml2-alpha.com/v1/";
const apiKey = process.env.LITELLM_API_KEY;
if (!apiKey) {
  console.error("LITELLM_API_KEY is required (LITELLM_BASE_URL and LITELLM_MODEL_ALIAS are optional)");
  process.exit(2);
}
const modelAlias = await resolveModelAlias(baseURL, apiKey, process.env.LITELLM_MODEL_ALIAS);
console.log("0 model alias:", modelAlias);
const profile = { ...DEFAULT_POLICY_PROFILE, modelAlias };
const client = createLiteLLMClient({ baseURL, apiKey, onCall: (info) => console.log("  usage:", info) });

const state: PolicyState = {
  runId: "smoke",
  step: 1,
  userGoal: "퇴직 전 미사용 연차는 어떻게 정산하나?",
  selectedMemories: [],
  activeCollections: ["work"],
  recentMessages: [],
  evidence: [],
  previousDecisions: [],
  remaining: { steps: 6, modelCalls: 8, searches: 3, verifies: 1, wallTimeMs: 180_000 },
};

const results: Record<string, boolean> = {};

// 1. text SSE
try {
  let text = "";
  for await (const event of client.streamAnswer({ userGoal: "한 문장으로 인사해줘", context: "", evidence: [] }, profile, new AbortController().signal)) {
    if (event.type === "text_delta") text += event.text;
  }
  results.stream = text.length > 0;
  console.log("1 stream:", text.slice(0, 80));
} catch (error) {
  results.stream = false;
  console.log("1 stream failed:", error);
}

// 2. schema-valid decision via forced tool call
try {
  const decision = await client.decide(state, profile, new AbortController().signal);
  const validation = validateDecision(decision, state);
  results.decision = validation.ok && decision.action === "SEARCH";
  console.log("2 decision:", JSON.stringify(decision), validation.ok ? "" : validation.reason);
} catch (error) {
  results.decision = false;
  console.log("2 decision failed:", error);
}

// 3. abort
try {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  await Array.fromAsync(client.streamAnswer({ userGoal: "1부터 500까지 세어줘", context: "", evidence: [] }, profile, controller.signal));
  results.abort = false;
} catch (error) {
  results.abort = (error as { code?: string }).code === "CANCELLED";
  console.log("3 abort:", (error as { code?: string }).code);
}

// 4. usage is reported by onCall above; verify a non-zero token count appeared in step 1/2
let sawUsage = false;
const usageClient = createLiteLLMClient({ baseURL, apiKey, onCall: (info) => { sawUsage ||= info.promptTokens > 0; } });
await Array.fromAsync(usageClient.streamAnswer({ userGoal: "hi", context: "", evidence: [] }, profile, new AbortController().signal));
results.usage = sawUsage;

// 5. prefix cache probe (informational): the same policy prompt twice behind a fresh nonce, so call 1 is cold and call 2 can hit.
// A hit shows as cachedPromptTokens > 0 (if the gateway reports it) or a clearly faster second call.
const probeCalls: ModelCallInfo[] = [];
const probeClient = createLiteLLMClient({ baseURL, apiKey, onCall: (info) => probeCalls.push(info), prompts: { policySystem: `probe ${Date.now()}\n${POLICY_SYSTEM}` } });
try {
  await probeClient.decide(state, profile, new AbortController().signal);
  await probeClient.decide(state, profile, new AbortController().signal);
} catch (error) {
  console.log("5 prefix cache probe failed:", error);
}
console.log("5 prefix cache:", probeCalls.map(({ latencyMs, promptTokens, cachedPromptTokens }) => ({ latencyMs, promptTokens, cachedPromptTokens })));

console.log(results);
process.exit(Object.values(results).every(Boolean) ? 0 : 1);
