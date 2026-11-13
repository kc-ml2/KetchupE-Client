// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { createLiteLLMClient, listModels, resolveModelAlias } from "./modelClient.ts";
import { DEFAULT_POLICY_PROFILE, GENERAL_ANSWER_SYSTEM, ANSWER_SYSTEM } from "./policy.ts";

afterEach(() => vi.unstubAllGlobals());

it.each(["general", "grounded"] as const)("sends the %s answer prompt to the generation model", async (answerMode) => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: "답변" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }));
  vi.stubGlobal("fetch", fetcher);
  const client = createLiteLLMClient({ baseURL: "https://gateway.example.com/v1/", apiKey: "test" });
  const events = [];
  for await (const event of client.streamAnswer({ userGoal: "질문", context: "이전 답변", evidence: [], answerMode }, DEFAULT_POLICY_PROFILE, new AbortController().signal)) events.push(event);
  const [, init] = fetcher.mock.calls[0];
  const body = JSON.parse(String(init?.body));
  expect(body.messages[0]).toEqual({ role: "system", content: answerMode === "general" ? GENERAL_ANSWER_SYSTEM : ANSWER_SYSTEM });
  expect(body.messages[1].content).toContain("이전 답변");
  expect(body.tools).toBeUndefined();
  expect(events).toContainEqual({ type: "text_delta", text: "답변" });
});

it("omits temperature from LiteLLM requests", async () => {
  let body: Record<string, unknown> | undefined;
  vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const chunks = [
      { choices: [{ delta: { role: "assistant", content: "o" } }] },
      { choices: [{ delta: { content: "k" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    ];
    return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
  }));

  const client = createLiteLLMClient({ baseURL: "https://gateway.example.com/v1/", apiKey: "test" });
  await expect(client.complete({ prompt: "hello" }, DEFAULT_POLICY_PROFILE, new AbortController().signal)).resolves.toBe("ok");
  expect(body).not.toHaveProperty("temperature");
  // Canvas drafts stream so a long generation is not cut by the proxy idle timeout (HTTP 524).
  expect(body).toMatchObject({ stream: true, chat_template_kwargs: { enable_thinking: false } });
});

it("resends once when the connection drops before any HTTP response", async () => {
  const fetch = vi.fn()
    .mockRejectedValueOnce(new TypeError("fetch failed", { cause: new Error("other side closed") }))
    .mockResolvedValueOnce(new Response(`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } }));
  vi.stubGlobal("fetch", fetch);
  const client = createLiteLLMClient({ baseURL: "https://gateway.example.com/v1/", apiKey: "test" });
  await expect(client.complete({ prompt: "hello" }, DEFAULT_POLICY_PROFILE, new AbortController().signal)).resolves.toBe("ok");
  expect(fetch).toHaveBeenCalledTimes(2);

  fetch.mockReset().mockRejectedValue(new TypeError("fetch failed", { cause: new Error("other side closed") }));
  await expect(client.complete({ prompt: "hello" }, DEFAULT_POLICY_PROFILE, new AbortController().signal)).rejects.toMatchObject({ code: "MODEL_PROTOCOL", message: expect.stringContaining("other side closed") });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("does not hide HTTP retries outside the harness budget", async () => {
  const fetch = vi.fn(async () => new Response("busy", { status: 503 }));
  vi.stubGlobal("fetch", fetch);
  const client = createLiteLLMClient({ baseURL: "https://gateway.example.com/v1/", apiKey: "test" });
  await expect(client.complete({ prompt: "hello" }, DEFAULT_POLICY_PROFILE, new AbortController().signal)).rejects.toMatchObject({ code: "MODEL_PROTOCOL" });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("validates JSON fallback verification results instead of trusting a type cast", async () => {
  let result: unknown = { supported: "yes", confidence: 2, missingClaims: [] };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    choices: [{ message: { role: "assistant", content: JSON.stringify(result) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }), { headers: { "content-type": "application/json" } })));
  const client = createLiteLLMClient({ baseURL: "https://gateway.example.com/v1/", apiKey: "test" });
  const input = { userGoal: "verify", claims: [], evidence: [] };
  await expect(client.verify(input, DEFAULT_POLICY_PROFILE, new AbortController().signal)).rejects.toMatchObject({ code: "MODEL_PROTOCOL" });
  result = { supported: true, confidence: 0.9, missingClaims: [] };
  await expect(client.verify(input, DEFAULT_POLICY_PROFILE, new AbortController().signal)).resolves.toEqual(result);
  expect(client.lastCall?.promptTokens).toBe(1);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("bounds model discovery even when no caller signal is provided", async () => {
  let requestSignal: AbortSignal | undefined;
  vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
    requestSignal = init.signal as AbortSignal;
    return new Response(JSON.stringify({ data: [{ id: "fixture" }] }));
  }));
  await expect(listModels("https://gateway.example.com/v1/", "test")).resolves.toEqual(["fixture"]);
  expect(requestSignal).toBeInstanceOf(AbortSignal);
  const controller = new AbortController();
  await listModels("https://gateway.example.com/v1/", "test", controller.signal);
  controller.abort();
  expect(requestSignal?.aborted).toBe(true);
});

it("uses loki only when the account's gateway exposes it", async () => {
  const gateway = (ids: string[]) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }))));
  gateway(["gpt-x", "loki"]);
  expect(await resolveModelAlias("https://g.example", "k")).toBe("loki");
  gateway(["gpt-x"]);
  expect(await resolveModelAlias("https://g.example", "k")).toBe("gpt-x");
  expect(await resolveModelAlias("https://g.example", "k", "chosen")).toBe("chosen");
});

it("turns thinking off on policy decisions", async () => {
  let body: Record<string, unknown> | undefined;
  vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response("busy", { status: 503 });
  }));

  const client = createLiteLLMClient({ baseURL: "https://gateway.example.com/v1/", apiKey: "test" });
  await client.decide({ runId: "r", step: 1, userGoal: "안녕?", selectedMemories: [], activeCollections: [], recentMessages: [], evidence: [], previousDecisions: [], remaining: { steps: 1, modelCalls: 1, searchCalls: 1, verifyCalls: 1 } } as never, DEFAULT_POLICY_PROFILE, new AbortController().signal).catch(() => undefined);
  expect(body).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });
  expect(body).not.toHaveProperty("reasoning_effort");
});

const unavailable = (status = 400) => new Response(JSON.stringify({ error: { message: "Invalid model name passed in model=retired. secret-key-must-not-escape", code: status } }), { status, headers: { "content-type": "application/json" } });
const modelsResponse = (ids: string[]) => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }));
const retiredProfile = { ...DEFAULT_POLICY_PROFILE, modelAlias: "retired" };
const answerInput = { userGoal: "안녕", context: "", evidence: [] };

it.each([400, 404])("does not discover or switch models after invalid-model HTTP %s", async (status) => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => unavailable(status));
  vi.stubGlobal("fetch", fetch);
  const client = createLiteLLMClient({ baseURL: "https://gateway.example/v1/", apiKey: "account-key" });
  await expect(client.complete({ prompt: "hello" }, retiredProfile, new AbortController().signal)).rejects.toMatchObject({ code: "MODEL_PROTOCOL" });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toMatchObject({ model: "retired" });
});

it.each([
  [400, "invalid messages"], [401, "Invalid model"], [403, "Invalid model"], [429, "rate limited"], [500, "Invalid model"],
])("does not switch models for HTTP %s: %s", async (status, message) => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message } }), { status: Number(status), headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  const client = createLiteLLMClient({ baseURL: "https://gateway.example/v1/", apiKey: "test" });
  await expect(client.complete({ prompt: "hello" }, retiredProfile, new AbortController().signal)).rejects.toMatchObject({ code: status === 401 || status === 403 ? "MODEL_AUTH" : "MODEL_PROTOCOL" });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("does not replay a partially received answer or log raw streaming errors", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const fetch = vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`)); },
      pull(controller) { controller.error(new Error("secret-upstream-detail")); },
    }), { headers: { "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetch);
    const client = createLiteLLMClient({ baseURL: "https://gateway.example/v1/", apiKey: "test" });
    await expect(Array.fromAsync(client.streamAnswer(answerInput, retiredProfile, new AbortController().signal))).rejects.toMatchObject({ code: "MODEL_PROTOCOL" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(consoleError).not.toHaveBeenCalled();
  } finally { consoleError.mockRestore(); }
});

it("validates model discovery and never picks the router as the default", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => modelsResponse(["clef-flash", "odin", "Loki", "ketchupe"])));
  await expect(resolveModelAlias("https://gateway.example", "test")).resolves.toBe("ketchupe");
  vi.stubGlobal("fetch", vi.fn(async () => modelsResponse(["clef-flash", "odin", "Loki"])));
  await expect(resolveModelAlias("https://gateway.example", "test")).resolves.toBe("Loki");
  vi.stubGlobal("fetch", vi.fn(async () => modelsResponse(["clef-flash", "odin"])));
  await expect(resolveModelAlias("https://gateway.example", "test")).resolves.toBe("odin");
  vi.stubGlobal("fetch", vi.fn(async () => modelsResponse(["clef-flash"])));
  await expect(resolveModelAlias("https://gateway.example", "test")).rejects.toMatchObject({ code: "MODEL_PROTOCOL" });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 42 }] }))));
  await expect(listModels("https://gateway.example", "test")).rejects.toMatchObject({ code: "MODEL_PROTOCOL" });
});
