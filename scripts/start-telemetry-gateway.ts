import "dotenv/config";
import { createTelemetryGateway } from "./telemetry-gateway.ts";

const server = createTelemetryGateway({
  langfuseHost: process.env.LANGFUSE_HOST ?? "https://cloud.langfuse.com",
  publicKey: process.env.LANGFUSE_PUBLIC_KEY ?? "",
  secretKey: process.env.LANGFUSE_SECRET_KEY ?? "",
  ingestToken: process.env.KETCHUPE_INGEST_TOKEN ?? "",
});
const port = Number(process.env.PORT ?? 4318);
server.listen(port, () => console.log(`KetchupE telemetry gateway listening on :${port}`));
