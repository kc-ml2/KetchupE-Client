// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(""), decryptString: () => "" } }));
const { loadModelSettings } = await import("./settings.ts");

const userData = mkdtempSync(join(tmpdir(), "ketchupe-settings-"));
writeFileSync(join(userData, "model-settings.json"), JSON.stringify({ baseURL: "https://gateway.example.com/v1/", modelAlias: "gpt-4o" }));

afterEach(() => {
  delete process.env.LITELLM_MODEL_ALIAS;
});

it("keeps the saved alias when the env var is present but empty", () => {
  process.env.LITELLM_MODEL_ALIAS = "";
  expect(loadModelSettings(userData).modelAlias).toBe("gpt-4o");
});

it("lets a non-empty env var override the saved alias", () => {
  process.env.LITELLM_MODEL_ALIAS = "claude-opus-5";
  expect(loadModelSettings(userData).modelAlias).toBe("claude-opus-5");
});

it("uses loki when no model alias is configured", () => {
  const emptyUserData = mkdtempSync(join(tmpdir(), "ketchupe-settings-empty-"));
  expect(loadModelSettings(emptyUserData).modelAlias).toBe("loki");
  rmSync(emptyUserData, { recursive: true, force: true });
});

process.on("exit", () => rmSync(userData, { recursive: true, force: true }));
