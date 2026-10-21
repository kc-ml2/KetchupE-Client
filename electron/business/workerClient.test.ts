// @vitest-environment node
import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock("electron", () => ({ utilityProcess: { fork: mock.fork } }));
import { executeBusinessJob } from "./workerClient.ts";
const job = { toolId: "daily_cash", version: "1.0", input: { values: {}, files: {}, checkpoint: {} } };
const child = () => {
  const process = Object.assign(new EventEmitter(), { kill: vi.fn(), postMessage: vi.fn() });
  mock.fork.mockReturnValue(process); return process;
};
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });
it("forwards a registered job and kills the worker after a result", async () => {
  const process = child(); const result = { status: "failed", message: "fixture" };
  const pending = executeBusinessJob("worker", job, new AbortController().signal);
  process.emit("spawn"); expect(process.postMessage).toHaveBeenCalledWith(job);
  process.emit("message", { ok: true, result });
  await expect(pending).resolves.toEqual(result); expect(process.kill).toHaveBeenCalledTimes(1);
});
it("kills a worker on cancel and ignores its late response", async () => {
  const process = child(); const abort = new AbortController();
  const pending = executeBusinessJob("worker", job, abort.signal);
  abort.abort(); process.emit("message", { ok: true, result: {} });
  await expect(pending).rejects.toThrow("중단"); expect(process.kill).toHaveBeenCalledTimes(1);
});
it("kills timed out workers and rejects process crashes", async () => {
  vi.useFakeTimers(); const process = child();
  const pending = executeBusinessJob("worker", job, new AbortController().signal);
  const assertion = expect(pending).rejects.toThrow("초과"); await vi.advanceTimersByTimeAsync(120000); await assertion;
  expect(process.kill).toHaveBeenCalledTimes(1);
  const other = child(); const crashed = executeBusinessJob("worker", job, new AbortController().signal);
  other.emit("exit", 1); await expect(crashed).rejects.toThrow("종료");
});
