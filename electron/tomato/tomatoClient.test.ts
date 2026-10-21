// @vitest-environment node
import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";

const child = Object.assign(new EventEmitter(), { kill: vi.fn(), postMessage: vi.fn() });
vi.mock("electron", () => ({ utilityProcess: { fork: () => child } }));
const { TomatoClient } = await import("./tomatoClient.ts");

it("rejects pending calls and waits for worker exit before the account can reopen its index", async () => {
  const client = new TomatoClient("worker", "/account-a/tomato", () => undefined);
  const request = client.call("listCollections", []);
  const rejected = expect(request).rejects.toMatchObject({ code: "CANCELLED" });
  let finished = false;
  const stopping = client.stop().then(() => { finished = true; });
  await rejected;
  expect(child.kill).toHaveBeenCalledOnce();
  expect(finished).toBe(false);
  expect(() => client.call("listCollections", [])).toThrow("tomato stopped");
  child.emit("exit", 0);
  await stopping;
  expect(finished).toBe(true);
  await client.stop();
  expect(child.kill).toHaveBeenCalledOnce();
});
