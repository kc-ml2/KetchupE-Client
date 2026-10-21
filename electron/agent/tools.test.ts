// @vitest-environment node
import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { withTimeout } from "./tools.ts";

describe("withTimeout", () => {
  it("removes abort listeners after successful and failed calls", async () => {
    const controller = new AbortController();
    for (let index = 0; index < 20; index += 1) {
      expect(await withTimeout(Promise.resolve(index), 100, "TOOL_TIMEOUT", controller.signal)).toBe(index);
    }
    await expect(withTimeout(Promise.reject(new Error("failed")), 100, "TOOL_TIMEOUT", controller.signal)).rejects.toThrow("failed");
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("handles already aborted and newly aborted signals", async () => {
    const controller = new AbortController();
    const pending = withTimeout(new Promise(() => undefined), 100, "TOOL_TIMEOUT", controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(withTimeout(Promise.resolve("late"), 100, "TOOL_TIMEOUT", controller.signal)).rejects.toMatchObject({ code: "CANCELLED" });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("times out without leaving a listener behind", async () => {
    const controller = new AbortController();
    await expect(withTimeout(new Promise(() => undefined), 1, "TOOL_TIMEOUT", controller.signal)).rejects.toMatchObject({ code: "TOOL_TIMEOUT" });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});
