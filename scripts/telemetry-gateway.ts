import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_STRING_CHARS = 16_000;
const UPSTREAM_TIMEOUT_MS = 30_000;

const redactString = (value: string) => value
  .slice(0, MAX_STRING_CHARS)
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[EMAIL]")
  .replace(/(?<!\d)(?:\+?82[- ]?)?0?1[016789][ -]?\d{3,4}[ -]?\d{4}(?!\d)/gu, "[PHONE]")
  .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b/gu, "[SECRET]")
  .replace(/\bBearer\s+[A-Za-z0-9._~-]+/giu, "Bearer [SECRET]")
  .replace(/\b[A-Z]:\\(?:[^\\\s"'<>]+\\)*[^\\\s"'<>]*/giu, "[PATH]")
  .replace(/(^|[\s"'(:])\/(?:[^/\s"'<>]+\/)+[^/\s"'<>]*/gmu, "$1[PATH]");

export function sanitizeTelemetry(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(sanitizeTelemetry);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      /^(?:api[_-]?key|secret(?:[_-]?key)?|private[_-]?key|access[_-]?token|refresh[_-]?token|authorization)$/i.test(key) ? "[SECRET]" : sanitizeTelemetry(nested),
    ]));
  }
  return value;
}

function authorized(request: IncomingMessage, expected: string): boolean {
  const actual = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function reply(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ message }));
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("payload too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function createTelemetryGateway(options: { langfuseHost: string; publicKey: string; secretKey: string; ingestToken: string }) {
  if (!options.langfuseHost || !options.publicKey || !options.secretKey || !options.ingestToken) throw new Error("Langfuse host/keys and KETCHUPE_INGEST_TOKEN are required");
  const target = `${options.langfuseHost.replace(/\/+$/, "")}/api/public/otel/v1/traces`;
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/healthz") return reply(response, 200, "ok");
    if (request.method !== "POST" || request.url !== "/v1/traces") return reply(response, 404, "not found");
    if (!authorized(request, options.ingestToken)) return reply(response, 401, "unauthorized");
    try {
      const body = JSON.parse((await readBody(request)).toString("utf8")) as { resourceSpans?: unknown[] };
      if (!Array.isArray(body.resourceSpans)) return reply(response, 400, "invalid OTLP payload");
      const upstream = await fetch(target, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${options.publicKey}:${options.secretKey}`).toString("base64")}`,
          "content-type": "application/json",
          "x-langfuse-ingestion-version": "4",
        },
        body: JSON.stringify(sanitizeTelemetry(body)),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      const retryAfter = upstream.headers.get("retry-after");
      response.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
        ...(retryAfter ? { "retry-after": retryAfter } : {}),
      });
      response.end(await upstream.text());
    } catch (error) {
      const status = error instanceof SyntaxError ? 400
        : error instanceof Error && error.message === "payload too large" ? 413
        : error instanceof Error && error.name === "TimeoutError" ? 504 : 502;
      reply(response, status, status >= 500 ? "telemetry upstream unavailable" : error instanceof Error ? error.message : String(error));
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = createTelemetryGateway({
    langfuseHost: process.env.LANGFUSE_HOST ?? "https://cloud.langfuse.com",
    publicKey: process.env.LANGFUSE_PUBLIC_KEY ?? "",
    secretKey: process.env.LANGFUSE_SECRET_KEY ?? "",
    ingestToken: process.env.KETCHUPE_INGEST_TOKEN ?? "",
  });
  const port = Number(process.env.PORT ?? 4318);
  server.listen(port, () => console.log(`KetchupE telemetry gateway listening on :${port}`));
}
