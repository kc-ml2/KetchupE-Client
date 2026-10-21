// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { createLiteLLMClient, listModels } from "./modelClient.ts";
import { DEFAULT_POLICY_PROFILE } from "./policy.ts";

afterEach(() => vi.unstubAllGlobals());

it("omits temperature from LiteLLM requests", async () => {
  let body: Record<string, unknown> | undefined;
  vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }));

  const client = createLiteLLMClient({ baseURL: "https://gateway.example.com/v1/", apiKey: "test" });
  await expect(client.complete({ prompt: "hello" }, DEFAULT_POLICY_PROFILE, new AbortController().signal)).resolves.toBe("ok");
  expect(body).not.toHaveProperty("temperature");
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
