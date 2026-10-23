import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { APICallError, generateText, streamText, tool, ToolChoiceViolationError } from "ai";
import type { ZodType } from "zod";
import {
  AgentError,
  LIMITS,
  PolicyDecisionSchema,
  VerificationResultSchema,
  type AgentErrorCode,
  type AnswerEvent,
  type AnswerInput,
  type PolicyDecision,
  type PolicyProfile,
  type PolicyState,
  type VerificationResult,
  type VerifyInput,
} from "./contracts.ts";
import { buildAnswerMessages, buildPolicyMessages, buildVerifyMessages } from "./policy.ts";

export const DEFAULT_LITELLM_BASE_URL = "https://centinels.ml2-alpha.com/v1/";
export const DEFAULT_LITELLM_MODEL_ALIAS = "loki";

/** Accepts a bare domain, a URL, or a URL with /v1; returns `https://host[/path]/v1/`. */
export function normalizeBaseURL(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return DEFAULT_LITELLM_BASE_URL;
  const withScheme = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withScheme);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = `${path.endsWith("/v1") ? path : `${path}/v1`}/`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** GET /models on the OpenAI-compatible gateway. The gateway is already wired to its upstream, so only domain + key are needed. */
export async function listModels(baseURL: string, apiKey: string, signal?: AbortSignal): Promise<string[]> {
  const timeout = AbortSignal.timeout(LIMITS.toolTimeoutMs);
  const response = await fetch(new URL("models", normalizeBaseURL(baseURL)), {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (response.status === 401 || response.status === 403) throw new AgentError("MODEL_AUTH", "LiteLLM 키가 거부되었습니다. 로그아웃 후 다시 인증해 주세요.");
  if (!response.ok) throw new AgentError("MODEL_PROTOCOL", `GET /models failed: ${response.status}`);
  const body = (await response.json()) as { data?: Array<{ id?: string }> };
  return (body.data ?? []).map((item) => item.id ?? "").filter(Boolean);
}

/** Explicit alias wins; otherwise loki when the gateway exposes it, else the first exposed model. */
export async function resolveModelAlias(baseURL: string, apiKey: string, explicit?: string): Promise<string> {
  if (explicit?.trim()) return explicit.trim();
  const models = await listModels(baseURL, apiKey);
  const alias = models.includes(DEFAULT_LITELLM_MODEL_ALIAS) ? DEFAULT_LITELLM_MODEL_ALIAS : models[0];
  if (!alias) throw new AgentError("MODEL_PROTOCOL", "LiteLLM이 노출하는 모델이 없습니다.");
  return alias;
}

export interface ModelClient {
  /** Usage/latency of the most recent call; read by the harness right after each call. */
  lastCall?: ModelCallInfo;
  /** Shared runtime clients isolate usage by the run's abort signal. */
  lastCallFor?: (signal: AbortSignal) => ModelCallInfo | undefined;
  decide(state: PolicyState, profile: PolicyProfile, signal: AbortSignal): Promise<PolicyDecision>;
  verify(input: VerifyInput, profile: PolicyProfile, signal: AbortSignal): Promise<VerificationResult>;
  streamAnswer(input: AnswerInput, profile: PolicyProfile, signal: AbortSignal): AsyncIterable<AnswerEvent>;
  /** Plain text completion (canvas classify/draft/edit). */
  complete(input: { system?: string; prompt: string; purpose?: ModelCallPurpose }, profile: PolicyProfile, signal: AbortSignal): Promise<string>;
}

export type ModelCallPurpose = "policy" | "verify" | "answer" | "canvas";

export type ModelCallInfo = {
  purpose: ModelCallPurpose;
  modelAlias: string;
  latencyMs: number;
  promptTokens: number;
  /** Prompt tokens the gateway served from its prefix cache; 0 also when the gateway does not report it. */
  cachedPromptTokens?: number;
  completionTokens: number;
  finishReason: string;
  /** Request start to the first streamed text; streaming calls only. */
  ttftMs?: number;
};

/** System-prompt overrides: the harness surface that benchmarks vary per promptVersion. Undefined = the built-in prompt. */
export type PromptOverrides = { policySystem?: string; answerSystem?: string; verifySystem?: string };

export type LiteLLMClientOptions = {
  baseURL: string;
  apiKey: string;
  onCall?: (info: ModelCallInfo) => void;
  prompts?: PromptOverrides;
};

export function toAgentError(error: unknown): AgentError {
  if (error instanceof AgentError) return error;
  if (error instanceof Error && error.name === "AbortError") return new AgentError("CANCELLED", "cancelled");
  if (error instanceof Error && error.name === "TimeoutError") return new AgentError("MODEL_TIMEOUT", "model timed out");
  if (APICallError.isInstance(error)) {
    // 200 means the body broke after headers (stream cut mid-way). The cause is a transport error, never the response body.
    if (error.statusCode === 200) {
      const cause = error.cause instanceof Error ? (error.cause.cause instanceof Error ? error.cause.cause.message : error.cause.message) : "";
      return new AgentError("MODEL_PROTOCOL", `모델 응답 스트림이 중간에 끊겼습니다${cause ? ` (${cause.slice(0, 120)})` : ""}.`);
    }
    if (error.statusCode === undefined) {
      const cause = error.cause instanceof Error ? (error.cause.cause instanceof Error ? error.cause.cause.message : error.cause.message) : "";
      return new AgentError("MODEL_PROTOCOL", `모델 서버 연결이 응답 전에 끊겼습니다${cause ? ` (${cause.slice(0, 120)})` : ""}.`);
    }
    const code: AgentErrorCode = error.statusCode === 401 || error.statusCode === 403 ? "MODEL_AUTH" : "MODEL_PROTOCOL";
    return new AgentError(code, error.statusCode === 401 ? "LiteLLM 인증이 만료되었거나 키가 거부되었습니다. 로그아웃 후 다시 인증해 주세요." : error.statusCode === 403 ? "이 모델에 접근할 권한이 없습니다. 운영자에게 확인해 주세요." : `모델 요청이 실패했습니다 (HTTP ${error.statusCode ?? "unknown"}).`);
  }
  return new AgentError("MODEL_PROTOCOL", "모델에 연결하지 못했거나 응답을 처리하지 못했습니다.");
}

/** Some gateways answer a forced tool call with JSON text instead. Accept that once. */
function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new AgentError("MODEL_PROTOCOL", "model returned neither tool call nor JSON");
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new AgentError("MODEL_PROTOCOL", "model returned invalid JSON");
  }
}

/**
 * The gateway can close a pooled keep-alive socket right after a response; the next request then fails instantly with
 * no HTTP status. Resend once on a fresh connection. Any HTTP response (including 5xx) is returned as is, never retried.
 */
export async function fetchWithConnectionRetry(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (error) {
    if (init?.signal?.aborted || !(error instanceof TypeError)) throw error;
    return fetch(input, init);
  }
}

const PROVIDER_NAME = "ketchupe-litellm";
/**
 * Turns off thinking on the vLLM-served Qwen behind LiteLLM (passed through as `chat_template_kwargs`).
 * With thinking on, a one-sentence answer took 17s/563 tokens vs 1s/34 off, and long answers hit MODEL_TIMEOUT.
 */
const NO_THINKING = { [PROVIDER_NAME]: { chat_template_kwargs: { enable_thinking: false } } };

export function createLiteLLMClient(options: LiteLLMClientOptions): ModelClient {
  const self: ModelClient = {} as ModelClient;
  const report = (info: ModelCallInfo) => {
    self.lastCall = info;
    options.onCall?.(info);
  };
  const provider = createOpenAICompatible({
    name: PROVIDER_NAME,
    baseURL: normalizeBaseURL(options.baseURL),
    apiKey: options.apiKey,
    includeUsage: true,
    fetch: fetchWithConnectionRetry,
  });

  async function structuredCall<T>(
    purpose: ModelCallPurpose,
    toolName: string,
    description: string,
    schema: ZodType<T>,
    messages: { system: string; prompt: string },
    profile: PolicyProfile,
    signal: AbortSignal,
  ): Promise<T> {
    const startedAt = Date.now();
    const validate = (value: unknown): T => {
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw new AgentError(toolName === "policy_decision" ? "INVALID_DECISION" : "MODEL_PROTOCOL", `model returned invalid ${toolName}`);
      return parsed.data;
    };
    try {
      const result = await generateText({
        model: provider(profile.modelAlias),
        system: messages.system,
        prompt: messages.prompt,
        abortSignal: signal,
        maxRetries: 0,
        tools: { [toolName]: tool({ description, inputSchema: schema }) },
        toolChoice: { type: "tool", toolName },
        providerOptions: NO_THINKING,
        onLanguageModelCallEnd: ({ usage, finishReason }) => report({
          purpose,
          modelAlias: profile.modelAlias,
          latencyMs: Date.now() - startedAt,
          promptTokens: usage.inputTokens ?? 0,
          cachedPromptTokens: usage.inputTokenDetails.cacheReadTokens,
          completionTokens: usage.outputTokens ?? 0,
          finishReason,
        }),
      });
      const call = result.toolCalls.find((item) => item.toolName === toolName);
      return validate(call ? call.input : extractJsonObject(result.text));
    } catch (error) {
      if (ToolChoiceViolationError.isInstance(error)) {
        const text = error.content.filter((part) => part.type === "text").map((part) => part.text).join("");
        return validate(extractJsonObject(text));
      }
      throw toAgentError(error);
    }
  }

  return Object.assign(self, {
    decide(state, profile, signal) {
      return structuredCall(
        "policy",
        "policy_decision",
        "Choose the next orchestration action with difficulty and probability estimates.",
        PolicyDecisionSchema,
        buildPolicyMessages(state, profile, options.prompts?.policySystem),
        profile,
        signal,
      );
    },
    verify(input, profile, signal) {
      return structuredCall(
        "verify",
        "verification_result",
        "Report whether the evidence supports the claims.",
        VerificationResultSchema,
        buildVerifyMessages(input, options.prompts?.verifySystem),
        profile,
        signal,
      );
    },
    async complete(input, profile, signal) {
      const startedAt = Date.now();
      try {
        // Streamed so long drafts keep bytes flowing; a silent request is cut at the gateway proxy's ~100s idle limit (HTTP 524).
        const result = streamText({ model: provider(profile.modelAlias), system: input.system, prompt: input.prompt, abortSignal: signal, maxRetries: 0, providerOptions: NO_THINKING, onError: () => undefined });
        let text = "";
        for await (const part of result.fullStream) {
          if (part.type === "text-delta") text += part.text;
          else if (part.type === "error") throw part.error;
        }
        const usage = await result.usage;
        report({ purpose: input.purpose ?? "canvas", modelAlias: profile.modelAlias, latencyMs: Date.now() - startedAt, promptTokens: usage.inputTokens ?? 0, completionTokens: usage.outputTokens ?? 0, finishReason: await result.finishReason });
        return text;
      } catch (error) {
        throw toAgentError(error);
      }
    },
    async *streamAnswer(input, profile, signal) {
      const startedAt = Date.now();
      const messages = buildAnswerMessages(input, options.prompts?.answerSystem);
      try {
        const result = streamText({
          model: provider(profile.modelAlias),
          system: messages.system,
          prompt: messages.prompt,
          abortSignal: signal,
          maxRetries: 0,
          providerOptions: NO_THINKING,
        });
        let ttftMs: number | undefined;
        for await (const text of result.textStream) {
          if (text) ttftMs ??= Date.now() - startedAt;
          yield { type: "text_delta", text };
        }
        const usage = await result.usage;
        const info: ModelCallInfo = {
          purpose: "answer",
          modelAlias: profile.modelAlias,
          latencyMs: Date.now() - startedAt,
          promptTokens: usage.inputTokens ?? 0,
          cachedPromptTokens: usage.inputTokenDetails.cacheReadTokens,
          completionTokens: usage.outputTokens ?? 0,
          finishReason: await result.finishReason,
          ttftMs,
        };
        report(info);
        yield { type: "completed", promptTokens: info.promptTokens, completionTokens: info.completionTokens };
      } catch (error) {
        throw toAgentError(error);
      }
    },
  } satisfies ModelClient);
}

export type FixtureScript = {
  decide: PolicyDecision[] | ((state: PolicyState) => PolicyDecision);
  answer?: string | ((input: AnswerInput) => string);
  verify?: VerificationResult | ((input: VerifyInput) => VerificationResult);
  /** Text completions for canvas prompts, in call order or by prompt. */
  complete?: string[] | ((prompt: string) => string);
  onCall?: (info: ModelCallInfo) => void;
};

/** Deterministic client for harness tests. */
export function createFixtureClient(script: FixtureScript): ModelClient {
  const queue = Array.isArray(script.decide) ? [...script.decide] : undefined;
  const completions = Array.isArray(script.complete) ? [...script.complete] : undefined;
  const self: ModelClient = {} as ModelClient;
  const report = (purpose: ModelCallPurpose) => {
    self.lastCall = { purpose, modelAlias: "fixture", latencyMs: 0, promptTokens: 0, completionTokens: 0, finishReason: "stop", ...(purpose === "answer" ? { ttftMs: 0 } : {}) };
    script.onCall?.(self.lastCall);
  };
  return Object.assign(self, {
    async decide(state) {
      report("policy");
      if (typeof script.decide === "function") return script.decide(state);
      const next = queue?.shift();
      if (!next) throw new AgentError("MODEL_PROTOCOL", "fixture has no more decisions");
      return next;
    },
    async verify(input) {
      report("verify");
      if (!script.verify) return { supported: true, missingClaims: [], confidence: 1 };
      return typeof script.verify === "function" ? script.verify(input) : script.verify;
    },
    async complete(input) {
      report("canvas");
      if (typeof script.complete === "function") return script.complete(input.prompt);
      const next = completions?.shift();
      if (next === undefined) throw new AgentError("MODEL_PROTOCOL", "fixture has no more completions");
      return next;
    },
    async *streamAnswer(input) {
      const text = typeof script.answer === "function" ? script.answer(input) : (script.answer ?? "");
      for (const piece of text.match(/.{1,24}/gsu) ?? []) yield { type: "text_delta", text: piece };
      report("answer");
      yield { type: "completed", promptTokens: 0, completionTokens: 0 };
    },
  } satisfies ModelClient);
}
