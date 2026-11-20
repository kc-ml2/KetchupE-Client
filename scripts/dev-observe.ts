import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { loadEnv } from "vite";
import { createTelemetryGateway } from "./telemetry-gateway.ts";

const env = loadEnv("development", process.cwd(), "");
const missing = ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"].filter((key) => !env[key]?.trim());
if (missing.length) throw new Error(`[observe] Set ${missing.join(", ")} in .env before starting.`);

// Use an isolated loopback gateway and a fresh token; do not reuse production ingestion settings.
const token = randomBytes(32).toString("hex");
const gateway = createTelemetryGateway({
  langfuseHost: env.LANGFUSE_HOST || "https://cloud.langfuse.com",
  publicKey: env.LANGFUSE_PUBLIC_KEY,
  secretKey: env.LANGFUSE_SECRET_KEY,
  ingestToken: token,
});
gateway.listen(0, "127.0.0.1");
await once(gateway, "listening");
const address = gateway.address();
if (!address || typeof address === "string") throw new Error("[observe] Could not determine gateway port.");
const endpoint = `http://127.0.0.1:${address.port}/v1/traces`;
console.log(`[observe] Local gateway ready: ${endpoint}`);
console.log("[observe] Langfuse delivery is verified only when traces arrive. Ctrl+C stops both processes.");

const child = spawn(process.execPath, ["node_modules/vite/bin/vite.js"], {
  stdio: "inherit",
  detached: process.platform !== "win32",
  env: {
    ...process.env,
    KETCHUPE_OTLP_ENDPOINT: endpoint,
    KETCHUPE_OTLP_TOKEN: token,
    KETCHUPE_ENVIRONMENT: env.KETCHUPE_ENVIRONMENT || "development",
    KETCHUPE_TELEMETRY_CONTENT_MODE: env.KETCHUPE_TELEMETRY_CONTENT_MODE || "ops",
  },
});

let stopping = false;
function stop(code: number): void {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  if (child.pid) {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      try { process.kill(-child.pid, "SIGTERM"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") console.error(error); }
      const timer = setTimeout(() => {
        try { process.kill(-child.pid!, "SIGKILL"); } catch { /* Process group already exited. */ }
      }, 5_000);
      timer.unref();
    }
  }
  gateway.close();
  gateway.closeAllConnections();
}
process.once("SIGINT", () => stop(130));
process.once("SIGTERM", () => stop(143));
child.once("error", (error) => {
  console.error(`[observe] Could not start Vite: ${error.message}`);
  stop(1);
});
child.once("exit", (code, signal) => stop(code ?? (signal ? 1 : 0)));
