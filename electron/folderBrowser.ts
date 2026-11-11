import { readdir, realpath, stat } from "node:fs/promises";
import { SUPPORTED_EXTENSIONS, SKIP_NAMES } from "./tomato/filePolicy.ts";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { FolderListing } from "../src/app-types/Agent.types.ts";

export function validateFolderPath(path: string): void {
  if (typeof path !== "string" || path.includes("\0") || path.includes("\\") || isAbsolute(path) || path.split("/").some((part) => part === ".." || part.includes(":"))) {
    throw new Error("허용되지 않는 경로입니다.");
  }
}

export async function resolveFolderPath(root: string, path: string): Promise<string> {
  validateFolderPath(path);
  const canonicalRoot = await realpath(root);
  const target = await realpath(resolve(canonicalRoot, path));
  const child = relative(canonicalRoot, target);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error("등록된 폴더 밖에는 접근할 수 없습니다.");
  return target;
}

export async function listFolder(root: string, path: string): Promise<FolderListing> {
  const target = await resolveFolderPath(root, path);
  const entries = await readdir(target, { withFileTypes: true });
  const visible = entries.filter((entry) => !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()));
  visible.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, "ko"));
  return {
    entries: await Promise.all(visible.slice(0, 1000).map(async (entry) => {
      const info = await stat(resolve(target, entry.name)).catch(() => null);
      const entryPath = [path, entry.name].filter(Boolean).join("/");
      const ignored = entryPath.split("/").some((part) => SKIP_NAMES.has(part));
      const unsupported = entry.isFile() && !SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase());
      return { searchStatus: ignored || unsupported ? "ignored" as const : entry.isFile() ? "pending" as const : undefined, statusReason: ignored ? "시스템·개발 파일 또는 제외 폴더 안의 항목입니다." : unsupported ? `검색을 지원하지 않는 파일 형식입니다: ${extname(entry.name) || "확장자 없음"}` : undefined, name: entry.name, path: [path, entry.name].filter(Boolean).join("/"), kind: entry.isDirectory() ? "directory" as const : "file" as const, size: info?.size, modifiedAt: info?.mtime.toISOString() };
    })),
    truncated: visible.length > 1000,
  };
}
