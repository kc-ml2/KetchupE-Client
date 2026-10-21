import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { WorkFile, WorkSource } from "../../src/app-types/WorkSource.types.ts";

export const MAX_WORKBOOK_BYTES = 20 * 1024 * 1024;
export class WorkSources {
  constructor(private readonly db: DatabaseSync) {}

  list(): WorkSource[] {
    return this.db.prepare("SELECT id, name, path AS displayPath, kind FROM work_sources ORDER BY name, id").all() as WorkSource[];
  }

  async register(paths: string[], kind: WorkSource["kind"]): Promise<WorkSource[]> {
    // Only native-dialog selections reach this method. No model or renderer supplied root paths.
    const entries = await Promise.all(paths.map(async (path) => {
      const canonical = await realpath(path);
      const info = await lstat(canonical);
      if (kind === "folder" ? !info.isDirectory() : !info.isFile() || extname(canonical).toLowerCase() !== ".xlsx") {
        throw new Error("폴더 또는 XLSX 파일을 선택해 주세요.");
      }
      return { path: canonical, name: basename(canonical) };
    }));
    this.db.exec("BEGIN");
    try {
      for (const entry of entries) this.db.prepare("INSERT OR IGNORE INTO work_sources (id, name, path, kind) VALUES (?, ?, ?, ?)").run(randomUUID(), entry.name, entry.path, kind);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.list();
  }

  remove(id: string): void { this.db.prepare("DELETE FROM work_sources WHERE id = ?").run(id); }

  private source(id: string): WorkSource {
    const item = this.list().find((source) => source.id === id);
    if (!item) throw new Error("연결이 해제된 업무 자료입니다. 파일이나 폴더를 다시 선택해 주세요.");
    return item;
  }

  async files(id: string): Promise<WorkFile[]> {
    const source = this.source(id);
    if (await realpath(source.displayPath) !== source.displayPath) throw new Error("자료 경로가 변경되었습니다. 다시 선택해 주세요.");
    if (source.kind === "file") return [{ sourceId: id, relativePath: "", name: source.name }];
    const files: WorkFile[] = [];
    let visited = 0;
    const walk = async (folder: string, depth: number): Promise<void> => {
      if (depth > 10) throw new Error("하위 폴더가 너무 깊습니다. 더 좁은 폴더를 선택해 주세요.");
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        if (++visited > 10000 || files.length >= 500) throw new Error("폴더가 너무 큽니다. 파일 500개 미만의 업무 폴더를 선택해 주세요.");
        if (entry.isSymbolicLink() || entry.name.startsWith(".") || entry.name.startsWith("~$")) continue;
        const path = join(folder, entry.name);
        if (entry.isDirectory()) {
          if (await realpath(path) !== path) throw new Error("폴더 경로가 변경되었습니다. 다시 선택해 주세요.");
          await walk(path, depth + 1);
        } else if (entry.isFile() && extname(path).toLowerCase() === ".xlsx") {
          files.push({ sourceId: id, relativePath: relative(source.displayPath, path), name: entry.name });
        }
      }
    };
    await walk(source.displayPath, 0);
    return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  async read(file: WorkFile): Promise<{ bytes: Buffer; fingerprint: string }> {
    const source = this.source(file.sourceId);
    if (typeof file.relativePath !== "string" || isAbsolute(file.relativePath)) throw new Error("잘못된 파일 경로입니다.");
    const target = source.kind === "file" ? source.displayPath : resolve(source.displayPath, file.relativePath);
    const rel = relative(source.displayPath, target);
    if ((source.kind === "file" && file.relativePath !== "") || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) {
      throw new Error("선택한 자료 범위 밖의 파일입니다.");
    }
    if (await realpath(target) !== target || await realpath(source.displayPath) !== source.displayPath) throw new Error("연결 경로가 변경되었거나 심볼릭 링크입니다. 원본을 다시 선택해 주세요.");
    if (extname(target).toLowerCase() !== ".xlsx") throw new Error("현재 업무 자료는 XLSX 형식만 지원합니다.");
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_WORKBOOK_BYTES) throw new Error("20MB 이하의 일반 XLSX 파일을 선택해 주세요.");
      // Bound the actual read too: a file may grow after stat(). Never modify or copy the source.
      const buffer = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const part = await handle.read(buffer, length, buffer.length - length, null);
        if (!part.bytesRead) break;
        length += part.bytesRead;
      }
      const after = await handle.stat();
      if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("읽는 동안 파일이 변경되었습니다. 저장을 마친 뒤 다시 읽어 주세요.");
      const bytes = buffer.subarray(0, length);
      return { bytes, fingerprint: createHash("sha256").update(bytes).digest("hex") };
    } finally { await handle.close(); }
  }

  async replace(file: WorkFile, expectedFingerprint: string, bytes: Uint8Array): Promise<void> {
    const source = this.source(file.sourceId);
    if (typeof file.relativePath !== "string" || isAbsolute(file.relativePath)) throw new Error("잘못된 파일 경로입니다.");
    const target = source.kind === "file" ? source.displayPath : resolve(source.displayPath, file.relativePath);
    const rel = relative(source.displayPath, target);
    if ((source.kind === "file" && file.relativePath !== "") || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) throw new Error("선택한 자료 범위 밖의 파일입니다.");
    if (await realpath(target) !== target || await realpath(source.displayPath) !== source.displayPath || extname(target).toLowerCase() !== ".xlsx") throw new Error("연결된 XLSX 경로가 변경되었습니다. 원본을 다시 선택해 주세요.");
    const current = await this.read(file);
    if (current.fingerprint !== expectedFingerprint) throw new Error("작업 중 원본 파일이 변경되었습니다. 최신 파일로 새 작업을 시작해 주세요.");
    if (bytes.length > MAX_WORKBOOK_BYTES) throw new Error("수정된 통합문서가 20MB 제한을 초과합니다.");
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("일반 XLSX 파일만 갱신할 수 있습니다.");
    const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, info.mode & 0o777);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      if (await realpath(target) !== target || (await lstat(target)).ino !== info.ino) throw new Error("원본 파일이 교체되었습니다. 최신 파일로 새 작업을 시작해 주세요.");
      await rename(temporary, target);
    } finally { await unlink(temporary).catch(() => undefined); }
  }
}
