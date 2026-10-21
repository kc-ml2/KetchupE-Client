// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFixtureClient, createLiteLLMClient } from "./modelClient.ts";
import { settingsBackedModelClient } from "./liveModelClient.ts";
import { DEFAULT_POLICY_PROFILE } from "./policy.ts";

vi.mock("./modelClient.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("./modelClient.ts")>(),
  createLiteLLMClient: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

describe("settings-backed model client", () => {
  it("keeps reported usage when schema validation fails and clears stale usage on network failure", async () => {
    const reported = createFixtureClient({ decide: [] });
    reported.complete = async () => {
      reported.lastCall = { purpose: "canvas", modelAlias: "fixture", latencyMs: 1, promptTokens: 10, completionTokens: 2, finishReason: "stop" };
      throw new Error("invalid schema");
    };
    const failed = createFixtureClient({ decide: [] });
    failed.complete = async () => { throw new Error("offline"); };
    vi.mocked(createLiteLLMClient).mockReturnValueOnce(reported).mockReturnValueOnce(failed);
    const client = settingsBackedModelClient(() => ({ baseURL: "https://example.com/v1/", apiKey: "test", modelAlias: "fixture" }), async () => "fixture");
    const signal = new AbortController().signal;
    await expect(client.complete({ prompt: "bad schema" }, DEFAULT_POLICY_PROFILE, signal)).rejects.toThrow("invalid schema");
    expect(client.lastCallFor?.(signal)?.promptTokens).toBe(10);
    await expect(client.complete({ prompt: "offline" }, DEFAULT_POLICY_PROFILE, signal)).rejects.toThrow("offline");
    expect(client.lastCallFor?.(signal)).toBeUndefined();
  });

  it("isolates usage for concurrent runs instead of reading another run's last call", async () => {
    let release!: () => void;
    const first = createFixtureClient({ decide: [] });
    first.complete = async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      first.lastCall = { purpose: "canvas", modelAlias: "first", latencyMs: 1, promptTokens: 10, completionTokens: 2, finishReason: "stop" };
      return "first";
    };
    const second = createFixtureClient({ decide: [], complete: ["second"] });
    vi.mocked(createLiteLLMClient).mockReturnValueOnce(first).mockReturnValueOnce(second);
    const client = settingsBackedModelClient(() => ({ baseURL: "https://example.com/v1/", apiKey: "test", modelAlias: "fixture" }), async () => "fixture");
    const signal1 = new AbortController().signal;
    const signal2 = new AbortController().signal;
    const pending = client.complete({ prompt: "first" }, DEFAULT_POLICY_PROFILE, signal1);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await client.complete({ prompt: "second" }, DEFAULT_POLICY_PROFILE, signal2);
    release();
    await pending;
    expect(client.lastCall?.modelAlias).toBe("first");
    expect(client.lastCallFor?.(signal1)?.promptTokens).toBe(10);
    expect(client.lastCallFor?.(signal2)?.modelAlias).toBe("fixture");
    expect(client.lastCallFor?.(new AbortController().signal)).toBeUndefined();
  });

  it("reads current settings on every call and rejects missing credentials", async () => {
    const live = createFixtureClient({ decide: [], complete: ["ok", "updated"] });
    vi.mocked(createLiteLLMClient).mockReturnValue(live);
    let settings = { baseURL: "https://example.com/v1/", apiKey: "first", modelAlias: "fixture" };
    const client = settingsBackedModelClient(() => settings, async () => settings.modelAlias);
    const signal = new AbortController().signal;
    await client.complete({ prompt: "hello" }, DEFAULT_POLICY_PROFILE, signal);
    settings = { ...settings, apiKey: "second" };
    await client.complete({ prompt: "again" }, DEFAULT_POLICY_PROFILE, signal);
    expect(createLiteLLMClient).toHaveBeenLastCalledWith({ baseURL: settings.baseURL, apiKey: "second" });
    settings = { ...settings, apiKey: "" };
    await expect(client.complete({ prompt: "no key" }, DEFAULT_POLICY_PROFILE, signal)).rejects.toMatchObject({ code: "MODEL_AUTH" });
  });
});
