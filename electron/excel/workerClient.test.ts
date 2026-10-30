// @vitest-environment node
import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock("electron", () => ({ utilityProcess: { fork: mock.fork } }));
import { executeExcelJob } from "./workerClient.ts";
const job = { kind: "profile" as const, bytes: new Uint8Array([1]) };
const child = () => {
  const process = Object.assign(new EventEmitter(), { kill: vi.fn(), postMessage: vi.fn() });
  mock.fork.mockReturnValue(process); return process;
};
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });
it("passes only job data to the worker and terminates on completion", async () => {
  const process = child();
  const pending = executeExcelJob("worker", job, new AbortController().signal);
  expect(mock.fork).toHaveBeenCalledWith("worker", [], { serviceName: "ketchupe-excel", stdio: "ignore" });
  process.emit("spawn"); await vi.waitFor(() => expect(process.postMessage).toHaveBeenCalledWith(job));
  process.emit("message", { ok: true, result: { sheets: [] } });
  await expect(pending).resolves.toEqual({ sheets: [] }); expect(process.kill).toHaveBeenCalledOnce();
});
it("terminates cancelled and timed-out workers without accepting late results", async () => {
  const process = child(), controller = new AbortController();
  const pending = executeExcelJob("worker", job, controller.signal);
  controller.abort(); process.emit("message", { ok: true, result: { sheets: [] } });
  await expect(pending).rejects.toThrow("중단"); expect(process.kill).toHaveBeenCalledOnce();
  vi.useFakeTimers(); const other = child();
  const timed = executeExcelJob("worker", job, new AbortController().signal);
  const assertion = expect(timed).rejects.toThrow("30초");
  await vi.advanceTimersByTimeAsync(30000); await assertion;
  expect(other.kill).toHaveBeenCalledOnce();
});
it("reuses one worker across jobs and replaces it after a crash", async () => {
  const { createExcelWorker } = await import("./workerClient.ts");
  const first = child(), worker = createExcelWorker("worker"), signal = new AbortController().signal;
  const a = worker.run(job, signal); first.emit("spawn");
  await vi.waitFor(() => expect(first.postMessage).toHaveBeenCalledOnce());
  first.emit("message", { ok: false, error: "bad range" }); await expect(a).rejects.toThrow("bad range");
  const b = worker.run(job, signal);
  await vi.waitFor(() => expect(first.postMessage).toHaveBeenCalledTimes(2));
  first.emit("message", { ok: true, result: { sheets: [] } }); await expect(b).resolves.toEqual({ sheets: [] });
  expect(mock.fork).toHaveBeenCalledOnce(); expect(first.kill).not.toHaveBeenCalled();
  first.emit("exit"); const second = child();
  const c = worker.run(job, signal); second.emit("spawn");
  await vi.waitFor(() => expect(second.postMessage).toHaveBeenCalledOnce());
  second.emit("message", { ok: true, result: { sheets: [] } }); await c;
  worker.close(); expect(second.kill).toHaveBeenCalledOnce();
});
