// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { accountModelSettings } from "./settings.ts";

const keys = { litellm: { base_url: "https://ketchupe.ml2-alpha.com/gateway", api_key: "personal-key" }, maru: { base_url: "https://ketchupe.ml2-alpha.com/maru/mcp", api_key: "maru-key" }, mock: false };
afterEach(() => vi.unstubAllEnvs());

it("ignores shared environment credentials and preserves the gateway prefix", () => {
  vi.stubEnv("LITELLM_API_KEY", "shared-key");
  vi.stubEnv("LITELLM_BASE_URL", "https://old.example/v1/");
  vi.stubEnv("LITELLM_MODEL_ALIAS", "");
  expect(accountModelSettings(keys)).toEqual({ baseURL: "https://ketchupe.ml2-alpha.com/gateway/v1/", apiKey: "personal-key", modelAlias: "" });
});

it("keeps the configured model alias without replacing the user's key", () => {
  vi.stubEnv("LITELLM_MODEL_ALIAS", "custom-model");
  expect(accountModelSettings(keys)).toMatchObject({ modelAlias: "custom-model", apiKey: "personal-key" });
});
