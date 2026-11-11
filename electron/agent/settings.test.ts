// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { accountModelSettings } from "./settings.ts";
import { configuredModel, modelConfig, parseModelConfig } from "./modelConfig.ts";

const keys = { litellm: { base_url: "https://ketchupe.ml2-alpha.com/gateway", api_key: "personal-key" }, maru: { base_url: "https://ketchupe.ml2-alpha.com/maru/mcp", api_key: "maru-key" }, mock: false };
afterEach(() => vi.unstubAllEnvs());

it("uses broker credentials and YAML models, ignoring environment overrides", () => {
  for (const name of ["LITELLM_BASE_URL", "LITELLM_API_KEY", "LITELLM_MODEL_ALIAS", "LITELLM_ROUTER_MODEL_ALIAS", "LITELLM_GENERATION_BASE_URL", "LITELLM_GENERATION_API_KEY", "LITELLM_GENERATION_MODEL_ALIAS", "LITELLM_DECISION_BASE_URL", "LITELLM_DECISION_API_KEY", "LITELLM_DECISION_MODEL_ALIAS"]) vi.stubEnv(name, "ignored");
  expect(accountModelSettings(keys)).toEqual({ baseURL: "https://ketchupe.ml2-alpha.com/gateway/v1/", apiKey: "personal-key", modelAlias: modelConfig.generation.default });
  expect(accountModelSettings(keys, "decision")).toEqual({ baseURL: "https://ketchupe.ml2-alpha.com/gateway/v1/", apiKey: "personal-key", modelAlias: modelConfig.decision.default });
});

it("resolves document overrides and defaults only for known categories", () => {
  const config = parseModelConfig("decision:\n  default: clef\ngeneration:\n  default: loki\n  document: writer\n");
  expect(configuredModel(config, "decision")).toBe("clef");
  expect(configuredModel(config, "generation", "document")).toBe("writer");
  delete config.generation.document;
  expect(configuredModel(config, "generation", "document")).toBe("loki");
  // @ts-expect-error Unknown categories are also rejected at compile time.
  expect(() => configuredModel(config, "generation", "documnt")).toThrow("Unknown LLM category");
  // @ts-expect-error Only the default category is registered for Clef.
  expect(() => configuredModel(config, "decision", "document")).toThrow("Unknown LLM category");
});

it.each([
  "decision: {default: clef}\ngeneration: {default: loki, documnt: writer}",
  "decision: {default: clef, policy: loki}\ngeneration: {default: loki}",
  "decision: {default: clef}\ngeneration: {document: writer}",
  "decision: {default: clef}\ngeneration: {default: \"\"}",
  "decision: {default: clef}\ngeneration: {default: 42}",
  "decision: {default: clef}\ngeneration: {default: loki}\nproviders: {}",
  "decision: {default: clef}\ngeneration: {default: loki, default: writer}",
])("rejects invalid YAML configuration: %s", (source) => {
  expect(() => parseModelConfig(source)).toThrow();
});
