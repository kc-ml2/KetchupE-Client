import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { safeStorage } from "electron";
import { DEFAULT_LITELLM_BASE_URL, DEFAULT_LITELLM_MODEL_ALIAS, normalizeBaseURL } from "./modelClient.ts";

export type ModelSettings = { baseURL: string; modelAlias: string; apiKey?: string };
type StoredSettings = { baseURL: string; modelAlias?: string; apiKeyEncrypted?: string };

const FILE_NAME = "model-settings.json";

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

/** Dev env and official build values win; saved settings are the fallback. The key never reaches the renderer or traces. */
export function loadModelSettings(userData: string): ModelSettings {
  let stored: StoredSettings = { baseURL: DEFAULT_LITELLM_BASE_URL, modelAlias: DEFAULT_LITELLM_MODEL_ALIAS };
  try {
    stored = { ...stored, ...(JSON.parse(readFileSync(join(userData, FILE_NAME), "utf8")) as StoredSettings) };
  } catch {
    // first run
  }
  let apiKey: string | undefined;
  if (stored.apiKeyEncrypted && safeStorage.isEncryptionAvailable()) {
    try {
      apiKey = safeStorage.decryptString(Buffer.from(stored.apiKeyEncrypted, "base64"));
    } catch {
      apiKey = undefined;
    }
  }
  const baseURL = process.env.LITELLM_BASE_URL?.trim() || undefined;
  const modelAlias = process.env.LITELLM_MODEL_ALIAS?.trim() || undefined;
  const packagedApiKey = process.env.LITELLM_API_KEY?.trim() || undefined;
  return {
    baseURL: normalizeBaseURL(baseURL ?? stored.baseURL),
    modelAlias: modelAlias ?? (stored.modelAlias?.trim() || DEFAULT_LITELLM_MODEL_ALIAS),
    apiKey: packagedApiKey ?? apiKey,
  };
}

export function saveModelSettings(userData: string, settings: ModelSettings): void {
  const path = join(userData, FILE_NAME);
  let previous: StoredSettings | undefined;
  try {
    previous = JSON.parse(readFileSync(path, "utf8")) as StoredSettings;
  } catch {
    previous = undefined;
  }
  let apiKeyEncrypted = previous?.apiKeyEncrypted;
  if (settings.apiKey !== undefined) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("이 환경에서는 API key를 안전하게 저장할 수 없습니다.");
    apiKeyEncrypted = settings.apiKey ? safeStorage.encryptString(settings.apiKey).toString("base64") : undefined;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ baseURL: normalizeBaseURL(settings.baseURL), modelAlias: settings.modelAlias.trim(), apiKeyEncrypted } satisfies StoredSettings, null, 2));
}
