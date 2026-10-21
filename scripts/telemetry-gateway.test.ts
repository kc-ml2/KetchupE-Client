// @vitest-environment node
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelemetryGateway, sanitizeTelemetry } from "./telemetry-gateway.ts";

afterEach(() => vi.unstubAllGlobals());

async function sendToGateway(body: string) {
  const server = createTelemetryGateway({ langfuseHost: "https://langfuse.test", publicKey: "public", secretKey: "secret", ingestToken: "token" });
  const request = Object.assign(Readable.from([Buffer.from(body)]), { method: "POST", url: "/v1/traces", headers: { authorization: "Bearer token" } });
  const writeHead = vi.fn();
  await new Promise<void>((resolve) => server.emit("request", request, { writeHead, end: resolve }));
  return writeHead;
}

describe("telemetry gateway", () => {
  it("bounds the upstream request and forwards Retry-After to the durable sender", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return new Response("busy", { status: 429, headers: { "retry-after": "60" } });
    }));
    const writeHead = await sendToGateway(JSON.stringify({ resourceSpans: [] }));
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(writeHead).toHaveBeenCalledWith(429, expect.objectContaining({ "retry-after": "60" }));
  });

  it("distinguishes invalid client JSON from an upstream timeout", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("timed out", "TimeoutError"); }));
    expect(await sendToGateway("invalid")).toHaveBeenCalledWith(400, expect.any(Object));
    expect(await sendToGateway(JSON.stringify({ resourceSpans: [] }))).toHaveBeenCalledWith(504, expect.any(Object));
  });

  it("redacts common secrets and identifiers recursively", () => {
    expect(sanitizeTelemetry({
      input: "a@b.com 010-1234-5678 Bearer abc.def sk-live_123456789012 /Users/me/secret.txt C:\\Users\\me\\secret.txt",
      apiKey: "plain-value",
    })).toEqual({
      input: "[EMAIL] [PHONE] Bearer [SECRET] [SECRET] [PATH] [PATH]",
      apiKey: "[SECRET]",
    });
  });

  it("keeps OTLP nanosecond timestamps, which contain phone-shaped digit runs", () => {
    const span = { startTimeUnixNano: "1790920781563000000", endTimeUnixNano: "1790920781587000000", traceId: "f7c0e6a78e4d46e08d6a70fbb404c612" };
    expect(sanitizeTelemetry(span)).toEqual(span);
  });
});
