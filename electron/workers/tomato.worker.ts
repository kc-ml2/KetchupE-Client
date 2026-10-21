// Runs inside an Electron utilityProcess: parse/OCR/embedding/search stay off the main event loop.
import { Tomato } from "../tomato/tomato.ts";
import type { WorkerRequest, WorkerResponse } from "../tomato/protocol.ts";

const home = process.argv[2];
if (!home) throw new Error("tomato worker requires a home directory argument");
const tomato = new Tomato(home);
const port = process.parentPort;

const post = (message: WorkerResponse) => port.postMessage(message);

async function handle(request: WorkerRequest): Promise<unknown> {
  switch (request.method) {
    case "registerCollection":
      return tomato.registerCollection(...request.args);
    case "remove":
      return tomato.remove(...request.args);
    case "listCollections":
      return tomato.listCollections();
    case "sync":
      return tomato.sync(...request.args);
    case "embedMissing":
      return tomato.embedMissing(request.args[0], (completed, total) => post({ id: request.id, progress: { completed, total } }));
    case "search":
      return tomato.search(...request.args);
    case "getNeighbors":
      return tomato.getNeighbors(...request.args);
    case "getChunks":
      return tomato.getChunks(...request.args);
    case "listSources":
      return tomato.listSources(...request.args);
    case "getSourceChunks":
      return tomato.getSourceChunks(...request.args);
    case "ingestFile":
      return tomato.ingestFile(...request.args);
    case "status":
      return tomato.status();
    case "collectionFingerprint":
      return tomato.collectionFingerprint(...request.args);
  }
}

port.on("message", (event: { data: WorkerRequest }) => {
  const request = event.data;
  handle(request)
    .then((result) => post({ id: request.id, ok: true, result }))
    .catch((error: unknown) => post({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }));
});
