import type { ServiceKeys } from "../auth/broker.ts";
import { normalizeBaseURL } from "./modelClient.ts";

export type ModelSettings = { baseURL: string; modelAlias: string; apiKey?: string };
export const TELEMETRY_CONTENT_MODES = ["ops", "redacted_eval", "internal_full"] as const;
export type TelemetryContentMode = (typeof TELEMETRY_CONTENT_MODES)[number];

/** Service-owned telemetry. Official builds bake these values in; end users cannot replace the collector. */
export type TelemetrySettings = {
  endpoint: string;
  token?: string;
  contentMode: TelemetryContentMode;
  environment: string;
  tenantId: string;
  /** Policy variant override; empty → deterministic assignment by install id. */
  variant: string;
};

export function loadTelemetrySettings(): TelemetrySettings {
  const requestedMode = process.env.KETCHUPE_TELEMETRY_CONTENT_MODE;
  const contentMode = TELEMETRY_CONTENT_MODES.includes(requestedMode as TelemetryContentMode)
    ? requestedMode as TelemetryContentMode
    : "ops";
  return {
    endpoint: (process.env.KETCHUPE_OTLP_ENDPOINT ?? "").trim(),
    token: process.env.KETCHUPE_OTLP_TOKEN?.trim() || undefined,
    contentMode,
    environment: process.env.KETCHUPE_ENVIRONMENT?.trim() || "production",
    tenantId: process.env.KETCHUPE_TENANT_ID?.trim() || "public",
    variant: process.env.KETCHUPE_VARIANT ?? "",
  };
}

/** Broker credentials always win over legacy environment or saved shared keys. */
export function accountModelSettings(keys: ServiceKeys): ModelSettings {
  return {
    baseURL: normalizeBaseURL(keys.litellm.base_url),
    apiKey: keys.litellm.api_key,
    // Empty → resolveModelAlias picks from what this account's gateway key exposes.
    modelAlias: process.env.LITELLM_MODEL_ALIAS?.trim() ?? "",
  };
}
