// @vitest-environment node
import { expect, it, vi } from "vitest";
import { openAgentDb } from "../db/openAgentDb.ts";
import { createThread, ensureWorkspace } from "./store.ts";
import { MaruAccess } from "./maruAccess.ts";
import type { MaruClient } from "./maru.ts";

it("rechecks a thread before reuse and a citation before opening, including after restart", async () => {
  const db = openAgentDb(":memory:"); ensureWorkspace(db);
  const thread = createThread(db, "default");
  const authorizeDocument = vi.fn().mockResolvedValue({});
  const readDocument = vi.fn().mockResolvedValue({ path: "/private/cache/fresh.pdf" });
  const client = { authorizeDocument, readDocument } as unknown as MaruClient;
  const access = new MaruAccess(db, client, "/private/cache");
  const document = { refId: "ref", provider: "maru" as const, storageId: "group-a", path: "report.pdf" };
  access.record(thread.id, [document]);
  db.prepare("UPDATE maru_documents SET local_path = ?").run("/private/cache/old.pdf");
  const restored = new MaruAccess(db, client, "/private/cache");
  const signal = new AbortController().signal;
  await restored.authorizeThread(thread.id, signal);
  expect(authorizeDocument).toHaveBeenCalledWith(document, signal);
  await expect(restored.sourcePath("maru:ref", signal)).resolves.toBe("/private/cache/fresh.pdf");
  await expect(restored.sourcePath("/private/cache/old.pdf", signal)).resolves.toBe("/private/cache/fresh.pdf");
  await expect(restored.sourcePath("/private/cache/untracked.pdf", signal)).rejects.toThrow("접근 권한");
  authorizeDocument.mockRejectedValueOnce(new Error("revoked"));
  await expect(restored.authorizeThread(thread.id, signal)).rejects.toThrow("revoked");
  readDocument.mockRejectedValueOnce(new Error("revoked"));
  await expect(restored.sourcePath("maru:ref", signal)).rejects.toThrow("revoked");
  await expect(restored.sourcePath("/local/document.pdf", signal)).resolves.toBe("/local/document.pdf");
  db.close();
});
