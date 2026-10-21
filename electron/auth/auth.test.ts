// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CredentialBroker } from "./broker.ts";
import { AuthSession } from "./session.ts";
import type { AuthState } from "../../src/app-types/Auth.types.ts";
import { openAgentDb } from "../db/openAgentDb.ts";
import { createThread, ensureWorkspace, listThreads } from "../agent/store.ts";

const crypto = vi.hoisted(() => ({ available: true }));
vi.mock("electron", () => ({ safeStorage: {
  isEncryptionAvailable: () => crypto.available,
  encryptString: (value: string) => Buffer.from(value).reverse(),
  decryptString: (value: Buffer) => Buffer.from(value).reverse().toString(),
} }));
const { CredentialStore, accountDirectory } = await import("./storage.ts");
const keys = { litellm: { base_url: "https://ketchupe.ml2-alpha.com/gateway", api_key: "personal-model-secret" }, maru: { base_url: "https://ketchupe.ml2-alpha.com/maru/mcp", api_key: "personal-maru-secret" }, mock: false };
const provider = { status: "arbitrary-provider-status", attempt_count: 1, error_code: null, needs_attention: false };
const challenge = { challenge_id: "d1501ff0-7eb0-4597-8d1e-9d861b7f64d4", expires_at: "2030-01-01T00:05:00Z" };
const verification = { access_token: "broker-secret", expires_at: "2030-01-01T00:10:00Z" };
const ready = { provisioning_status: "ready", providers: { litellm: provider, maru: provider } };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function fixture(bodies: Response[]) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => bodies.shift()!);
  const store = { load: vi.fn(), save: vi.fn(), clear: vi.fn() };
  const lifecycle = { activate: vi.fn().mockResolvedValue("session-a"), deactivate: vi.fn().mockResolvedValue(undefined) };
  const changes: AuthState[] = [];
  const session = new AuthSession(new CredentialBroker(fetcher), store, lifecycle, (state) => changes.push(state));
  return { session, store, lifecycle, changes, fetcher };
}
afterEach(() => { vi.useRealTimers(); crypto.available = true; });

it("uses 202, preserves leading zeros, polls the public prefix, and never exposes tokens", async () => {
  const f = fixture([response(challenge, 202), response(verification, 202), response({ ...ready, provisioning_status: "pending" }), response(ready), response(keys)]);
  await f.session.requestCode("a@kct.co.kr");
  await f.session.verifyCode("012345");
  expect(f.session.getState().phase).toBe("provisioning");
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.session.getState()).toMatchObject({ phase: "ready", email: "a@kct.co.kr", sessionId: "session-a" });
  expect(JSON.parse(f.fetcher.mock.calls[1][1]!.body as string).code).toBe("012345");
  expect(f.fetcher.mock.calls.map(([url]) => String(url))).toEqual([
    "https://ketchupe.ml2-alpha.com/server/v1/auth/email/request",
    "https://ketchupe.ml2-alpha.com/server/v1/auth/email/verify",
    "https://ketchupe.ml2-alpha.com/server/v1/keys/status",
    "https://ketchupe.ml2-alpha.com/server/v1/keys/status",
    "https://ketchupe.ml2-alpha.com/server/v1/keys",
  ]);
  expect(f.fetcher.mock.calls[2][1]!.headers).toEqual({ Authorization: "Bearer broker-secret" });
  expect(f.store.save).toHaveBeenCalledWith({ email: "a@kct.co.kr", keys });
  expect(JSON.stringify(f.changes)).not.toMatch(/broker-secret|personal-model-secret|personal-maru-secret|access_token|api_key/);
});

it.each([true, undefined])("blocks mock=%s including the schema default", async (mock) => {
  const f = fixture([response(challenge, 202), response(verification, 202), response(ready), response({ ...keys, mock })]);
  await f.session.requestCode("a@kct.co.kr"); await f.session.verifyCode("012345");
  expect(f.session.getState().phase).toBe("action_required");
  expect(f.store.save).not.toHaveBeenCalled(); expect(f.lifecycle.activate).not.toHaveBeenCalled();
});

it.each(["action_required", "attention"])("stops polling on %s", async (kind) => {
  const status = kind === "attention" ? { ...ready, providers: { ...ready.providers, maru: { ...provider, needs_attention: true } } } : { ...ready, provisioning_status: kind };
  const f = fixture([response(challenge, 202), response(verification, 202), response(status)]);
  await f.session.requestCode("a@kct.co.kr"); await f.session.verifyCode("012345");
  await vi.advanceTimersByTimeAsync(130000);
  expect(f.session.getState().phase).toBe("action_required"); expect(f.fetcher).toHaveBeenCalledTimes(3);
});

it("bounds pending polling and requires a user retry", async () => {
  const f = fixture([response(challenge, 202), response(verification, 202)]);
  await f.session.requestCode("a@kct.co.kr");
  f.fetcher.mockImplementation(async (url) => String(url).endsWith("verify") ? response(verification, 202) : response({ ...ready, provisioning_status: "pending" }));
  await f.session.verifyCode("012345"); await vi.advanceTimersByTimeAsync(125000);
  expect(f.session.getState().phase).toBe("paused");
  const calls = f.fetcher.mock.calls.length;
  await vi.advanceTimersByTimeAsync(20000); expect(f.fetcher).toHaveBeenCalledTimes(calls);
});

it("expires the broker token without requesting service keys", async () => {
  const f = fixture([response(challenge, 202), response({ ...verification, expires_at: "2030-01-01T00:00:03Z" }, 202), response({ ...ready, provisioning_status: "pending" })]);
  await f.session.requestCode("a@kct.co.kr"); await f.session.verifyCode("012345");
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.session.getState().phase).toBe("signed_out"); expect(f.fetcher).toHaveBeenCalledTimes(3);
});

it("ignores a late verification after logout", async () => {
  const f = fixture([response(challenge, 202)]);
  await f.session.requestCode("a@kct.co.kr");
  let finish!: (value: Response) => void;
  f.fetcher.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const verifying = f.session.verifyCode("012345");
  await f.session.logout(); finish(response(verification, 202)); await verifying;
  expect(f.session.getState().phase).toBe("signed_out"); expect(f.lifecycle.activate).not.toHaveBeenCalled();
});

it("waits for an activation already in progress before closing the account", async () => {
  const f = fixture([response(challenge, 202), response(verification, 202), response(ready), response(keys)]);
  let finish!: (sessionId: string) => void;
  f.lifecycle.activate.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  await f.session.requestCode("a@kct.co.kr");
  const verifying = f.session.verifyCode("012345");
  await vi.waitFor(() => expect(f.lifecycle.activate).toHaveBeenCalled());
  const signingOut = f.session.logout();
  expect(f.session.getState().phase).toBe("signing_out");
  expect(f.lifecycle.deactivate).not.toHaveBeenCalled();
  finish("session-a");
  await verifying; await signingOut;
  expect(f.session.getState().phase).toBe("signed_out");
  expect(f.changes.some((state) => state.phase === "ready")).toBe(false);
  expect(f.lifecycle.deactivate).toHaveBeenCalledOnce();
});

it("supersedes a late code request instead of restoring the old challenge", async () => {
  const f = fixture([]);
  let finish!: (response: Response) => void;
  f.fetcher.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValueOnce(response(challenge, 202));
  const old = f.session.requestCode("a@kct.co.kr");
  await f.session.requestCode("b@kct.co.kr");
  finish(response(challenge, 202)); await old;
  expect(f.session.getState()).toMatchObject({ phase: "code", email: "b@kct.co.kr" });
});

it("never echoes validation inputs or accepts untrusted endpoints", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ detail: [{ input: "secret-code" }] }, 422)).mockResolvedValueOnce(response({ ...keys, maru: { ...keys.maru, base_url: "https://attacker.example/mcp" } }));
  const broker = new CredentialBroker(fetcher);
  await expect(broker.requestCode("a@kct.co.kr", new AbortController().signal)).rejects.toThrow("입력 내용을 확인");
  await expect(broker.keys("secret", new AbortController().signal)).rejects.toThrow("응답 형식");
});

it("isolates SQLite databases, preserves legacy data, and removes only the active credentials", () => {
  const root = mkdtempSync(join(tmpdir(), "account-isolation-"));
  try {
    writeFileSync(join(root, "agent.sqlite"), "legacy-do-not-touch");
    const a = accountDirectory(root, "a@kct.co.kr"), b = accountDirectory(root, "b@kct.co.kr");
    expect(a).not.toBe(b); expect(a).not.toContain("a@kct");
    const dbA = openAgentDb(join(a, "agent.sqlite")); ensureWorkspace(dbA);
    const thread = createThread(dbA, "default"); dbA.close();
    const dbB = openAgentDb(join(b, "agent.sqlite")); ensureWorkspace(dbB);
    expect(listThreads(dbB, "default")).toEqual([]); dbB.close();
    const reopened = openAgentDb(join(a, "agent.sqlite"));
    expect(listThreads(reopened, "default").map((item) => item.id)).toEqual([thread.id]); reopened.close();
    const store = new CredentialStore(root);
    store.save({ email: "a@kct.co.kr", keys });
    expect(readFileSync(join(root, "login.enc"), "utf8")).not.toContain(keys.litellm.api_key);
    expect(store.load()?.email).toBe("a@kct.co.kr");
    crypto.available = false;
    expect(() => store.save({ email: "b@kct.co.kr", keys })).toThrow("안전하게 저장");
    crypto.available = true;
    expect(store.load()?.email).toBe("a@kct.co.kr");
    store.clear(); expect(store.load()).toBeUndefined();
    expect(readFileSync(join(root, "agent.sqlite"), "utf8")).toBe("legacy-do-not-touch");
    expect(readFileSync(join(a, "agent.sqlite")).length).toBeGreaterThan(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
