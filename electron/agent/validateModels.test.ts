// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { validateAccountModels } from "./validateModels.ts";

const keys = { litellm: { base_url: "https://account.example/gateway", api_key: "account-secret" }, maru: { base_url: "https://account.example/maru", api_key: "maru-secret" }, mock: false };
const config = { decision: { default: "clef-flash" }, generation: { default: "loki", document: "writer" } };
const response = (ids: string[]) => Response.json({ data: ids.map(id => ({ id })) });
afterEach(() => vi.unstubAllGlobals());

it("accepts configured models even when the account exposes additional models", async () => {
  const fetcher = vi.fn().mockResolvedValue(response(["clef-flash", "loki", "writer", "extra"]));
  vi.stubGlobal("fetch", fetcher);
  await expect(validateAccountModels(keys, config)).resolves.toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(String(fetcher.mock.calls[0][0])).toBe("https://account.example/gateway/v1/models");
  expect(fetcher.mock.calls[0][1].headers.Authorization).toBe("Bearer account-secret");
});

it("reports all missing categories and compares IDs case-sensitively", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(["clef-flash", "Loki"])));
  await expect(validateAccountModels(keys, config)).rejects.toThrow("generation.default=loki, generation.document=writer");
});

it("checks the effective document default when the override is omitted", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(["clef-flash", "loki"])));
  await expect(validateAccountModels(keys, { decision: config.decision, generation: { default: "loki" } })).resolves.toBeUndefined();
});

it.each([401, 500])("blocks activation on HTTP %s without exposing upstream secrets", async (status) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("account-secret", { status })));
  await expect(validateAccountModels(keys, config)).rejects.toThrow("서버의 모델 목록을 확인하지 못했습니다");
});

it("blocks activation when the list cannot be read", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("account-secret")));
  await expect(validateAccountModels(keys, config)).rejects.toThrow("서버의 모델 목록을 확인하지 못했습니다");
});
