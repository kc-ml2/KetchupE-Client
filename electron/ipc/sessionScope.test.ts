// @vitest-environment node
import { expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
vi.mock("electron", () => ({ ipcMain: { handle: (name: string, listener: (...args: unknown[]) => unknown) => handlers.set(name, listener), removeHandler: (name: string) => handlers.delete(name) } }));
const { SessionScope } = await import("./sessionScope.ts");

it("blocks old sessions, drains in-flight calls, and never delivers their result to the next account", async () => {
  const a = new SessionScope("a", () => true);
  let finish!: (value: string) => void;
  a.handle("data", () => new Promise<string>((resolve) => { finish = resolve; }));
  const oldHandler = handlers.get("data")!;
  expect(() => oldHandler({} as IpcMainInvokeEvent, "b")).toThrow("로그인이 필요");
  const result = oldHandler({}, "a") as Promise<string>;
  await Promise.resolve();
  const rejected = expect(result).rejects.toThrow("세션이 종료");
  let drained = false;
  const closed = a.close().then(() => { drained = true; });
  await Promise.resolve(); expect(drained).toBe(false);
  finish("private A data"); await rejected; await closed;
  const b = new SessionScope("b", () => true);
  b.handle("data", () => "B data");
  expect(() => handlers.get("data")!({}, "a")).toThrow("로그인이 필요");
  await expect(handlers.get("data")!({}, "b")).resolves.toBe("B data");
  await b.close();
});

it("rejects requests from an untrusted renderer", () => {
  const scope = new SessionScope("a", () => false);
  scope.handle("private", () => "secret");
  expect(() => handlers.get("private")!({}, "a")).toThrow("로그인이 필요");
});
