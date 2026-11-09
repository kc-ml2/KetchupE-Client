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
  const assertion = expect(pending).rejects.toThrow("초과");
  await vi.advanceTimersByTimeAsync(120000); expect(process.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(360000); await assertion;
  expect(process.kill).toHaveBeenCalledTimes(1);
  const other = child(); const crashed = executeBusinessJob("worker", job, new AbortController().signal);
  other.emit("exit", 1); await expect(crashed).rejects.toThrow("종료");
});
it("allows a started job to close Excel after cancel without publishing its late result", async () => {
  const process = child(), abort = new AbortController();
  const pending = executeBusinessJob("worker", job, abort.signal);
  process.emit("spawn"); abort.abort();
  await expect(pending).rejects.toThrow("중단");
  expect(process.postMessage).toHaveBeenLastCalledWith({ cancel: true });
  expect(process.kill).not.toHaveBeenCalled();
  process.emit("message", { ok: true, result: { status: "completed" } });
  expect(process.kill).toHaveBeenCalledTimes(1);
});
it("holds the Mac Excel lock until cancelled work has finished cleanup", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "darwin" });
  try {
    const worker = child(), abort = new AbortController();
    const pending = executeBusinessJob("worker", job, abort.signal);
    worker.emit("spawn"); abort.abort();
    await expect(pending).rejects.toThrow("중단");
    await expect(executeBusinessJob("worker", job, new AbortController().signal)).rejects.toThrow("정리 중");
    worker.emit("message", { ok: false, error: "cancelled" });
    const next = child();
    const resumed = executeBusinessJob("worker", job, new AbortController().signal);
    next.emit("message", { ok: true, result: { status: "failed", message: "fixture" } });
    await expect(resumed).resolves.toMatchObject({ status: "failed" });
  } finally { Object.defineProperty(process, "platform", platform); }
});
it("still immediately terminates cancelled jobs that do not use native Excel", async () => {
  const worker = child(), abort = new AbortController();
  const pending = executeBusinessJob("worker", { ...job, toolId: "test_tool" }, abort.signal);
  worker.emit("spawn"); abort.abort();
  await expect(pending).rejects.toThrow("중단");
  expect(worker.kill).toHaveBeenCalledTimes(1);
});
