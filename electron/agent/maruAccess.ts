import type { DatabaseSync } from "node:sqlite";
import { isAbsolute, relative } from "node:path";
import { AgentError, type ExternalDocumentRef } from "./contracts.ts";
import type { MaruClient } from "./maru.ts";

export class MaruAccess {
  constructor(private readonly db: DatabaseSync, private readonly maru: MaruClient, private readonly cacheDirectory: string) {}

  record(threadId: string, documents: ExternalDocumentRef[]): void {
    const insert = this.db.prepare("INSERT INTO maru_documents (thread_id, ref_id, document) VALUES (?, ?, ?) ON CONFLICT(thread_id, ref_id) DO UPDATE SET document = excluded.document");
    for (const document of documents) insert.run(threadId, document.refId, JSON.stringify(document));
  }

  async authorizeThread(threadId: string, signal: AbortSignal): Promise<void> {
    const rows = this.db.prepare("SELECT document FROM maru_documents WHERE thread_id = ?").all(threadId) as { document: string }[];
    for (const row of rows) {
      signal.throwIfAborted();
      await this.maru.authorizeDocument(JSON.parse(row.document) as ExternalDocumentRef, signal);
    }
  }

  async sourcePath(path: string, signal: AbortSignal): Promise<string> {
    const local = relative(this.cacheDirectory, path);
    const remote = path.startsWith("maru:");
    const inCache = !isAbsolute(local) && local !== ".." && !local.startsWith("../") && !local.startsWith("..\\");
    if (!remote && !inCache) return path;
    const row = (remote
      ? this.db.prepare("SELECT document FROM maru_documents WHERE ref_id = ? LIMIT 1").get(path.slice(5))
      : this.db.prepare("SELECT document FROM maru_documents WHERE local_path = ? LIMIT 1").get(path)) as { document: string } | undefined;
    if (!row) throw new AgentError("TOOL_UNAVAILABLE", "MARU 원본의 접근 권한을 확인할 수 없습니다.");
    return (await this.maru.readDocument(JSON.parse(row.document) as ExternalDocumentRef, signal)).path;
  }
}
