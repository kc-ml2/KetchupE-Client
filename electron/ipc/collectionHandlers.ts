import { basename, extname, join, relative, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { z } from "zod";
import { stat } from "node:fs/promises";
import { listFolder, resolveFolderPath, validateFolderPath } from "../folderBrowser.ts";
import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import type { AgentRuntime } from "../agent/runtime.ts";
import { MARU_STORAGE_PREFIX, setCollectionActive } from "../agent/store.ts";
import { TOMATO_LONG_CALL_TIMEOUT_MS } from "../tomato/tomatoClient.ts";
import { WorkSources } from "../work/sources.ts";

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function collectionNameFor(folder: string, taken: Set<string>): string {
  const cleaned = basename(folder).normalize("NFKD").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^[-_]+/, "").slice(0, 40);
  // "maru_" is reserved for remote MARU indexes, which are hidden from local collections.
  const safe = cleaned.startsWith("maru_") ? `local-${cleaned}` : cleaned;
  const base = NAME_PATTERN.test(safe) ? safe : `folder-${Date.now().toString(36)}`;
  let name = base;
  for (let suffix = 2; taken.has(name); suffix += 1) name = `${base}-${suffix}`;
  return name;
}

export function registerCollectionHandlers(runtime: AgentRuntime, handle: typeof ipcMain.handle = ipcMain.handle.bind(ipcMain), assertActive: () => void = () => undefined): void {
  const locationSchema = z.object({ kind: z.enum(["local", "maru"]), id: z.string().min(1), path: z.string() });
  const rootFor = (id: string) => {
    const collection = runtime.collections().find((item) => item.name === id && !item.name.startsWith("maru_"));
    if (!collection) throw new Error("등록된 폴더를 찾을 수 없습니다.");
    return collection.path;
  };
  handle("folder:browse", async (_event, input: unknown) => {
    const location = locationSchema.parse(input);
    validateFolderPath(location.path);
    if (location.kind === "maru") return runtime.browseMaruFolder(location.id, location.path);
    const root = rootFor(location.id);
    await runtime.assertSourcePaths([await resolveFolderPath(root, location.path)]);
    assertActive();
    const listing = await listFolder(root, location.path);
    const sources = await runtime.tomato.listSources([location.id]);
    const indexed = new Set(sources.map((source) => source.relativePath));
    const state = runtime.watchers.state(location.id);
    const failed = new Map((state?.lastReport?.failed ?? []).map((failure) => [failure.path, failure.error]));
    for (const entry of listing.entries) {
      if (entry.kind === "directory") {
        const prefix = `${entry.path}/`;
        const failedPaths = new Set((state?.lastReport?.failed ?? []).map((failure) => relative(root, failure.path).split(sep).join("/")));
        entry.counts = { searchable: sources.filter((source) => source.relativePath.startsWith(prefix) && !failedPaths.has(source.relativePath)).length, failed: [...failedPaths].filter((path) => path.startsWith(prefix)).length };
      }
      if (entry.kind !== "file" || entry.searchStatus === "ignored") continue;
      const failure = failed.get(join(root, entry.path));
      entry.searchStatus = state?.retryingFile === entry.path ? "analyzing" : failure ? "failed" : indexed.has(entry.path) ? "searchable" : "pending";
      entry.statusReason = failure;
    }
    assertActive();
    return listing;
  });
  handle("folder:retry", async (_event, input: unknown) => {
    const location = locationSchema.parse(input);
    if (location.kind !== "local") throw new Error("로컬 파일만 재시도할 수 있습니다.");
    const path = await resolveFolderPath(rootFor(location.id), location.path);
    await runtime.assertSourcePaths([path]);
    assertActive();
    await runtime.watchers.retryFile(location.id, location.path);
  });
  handle("folder:openLocal", async (_event, input: unknown) => {
    const location = locationSchema.parse(input);
    if (location.kind !== "local") throw new Error("로컬 문서만 직접 열 수 있습니다.");
    const path = await resolveFolderPath(rootFor(location.id), location.path);
    await runtime.assertSourcePaths([path]);
    // Only document/media formats may launch their default application, never scripts or executables.
    const extensions = new Set([".pdf", ".txt", ".md", ".csv", ".tsv", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".hwp", ".hwpx", ".odt", ".ods", ".odp", ".rtf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff"]);
    if (!extensions.has(extname(path).toLowerCase()) || !(await stat(path)).isFile()) throw new Error("직접 열 수 없는 파일 형식입니다. 파일 위치 보기를 이용해 주세요.");
    assertActive();
    const error = await shell.openPath(path);
    if (error) throw new Error("문서를 열지 못했습니다. 연결된 기본 앱을 확인해 주세요.");
  });
  // Reveal, rather than execute, arbitrary user files in the OS file manager.
  handle("folder:reveal", async (_event, input: unknown) => {
    const location = locationSchema.parse(input);
    validateFolderPath(location.path);
    const path = location.kind === "maru"
      ? await runtime.downloadMaruFile(location.id, location.path)
      : await resolveFolderPath(rootFor(location.id), location.path);
    if (location.kind === "local") await runtime.assertSourcePaths([path]);
    if (!(await stat(path)).isFile()) throw new Error("파일을 선택해 주세요.");
    assertActive();
    shell.showItemInFolder(path);
  });
  handle("collection:list", (_event, workspaceId: string) => runtime.collectionSummaries(workspaceId));
  handle("collection:setActive", (_event, workspaceId: string, name: string, active: boolean) => setCollectionActive(runtime.db, workspaceId, name, active));
  handle("maru:listStorages", (_event, workspaceId: string) => runtime.maruStorages(workspaceId));
  handle("maru:setStorageActive", (_event, workspaceId: string, storageId: string, active: boolean) => setCollectionActive(runtime.db, workspaceId, `${MARU_STORAGE_PREFIX}${String(storageId)}`, Boolean(active)));

  // The renderer never supplies a path: only the native dialog result is registered.
  handle("collection:add", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const picked = window
      ? await dialog.showOpenDialog(window, { properties: ["openDirectory"] })
      : await dialog.showOpenDialog({ properties: ["openDirectory"] });
    assertActive();
    if (picked.canceled || !picked.filePaths[0]) return null;
    const folder = picked.filePaths[0];
    await runtime.assertSourcePaths([folder]);
    assertActive();
    const consent = await dialog.showMessageBox({
      type: "info",
      buttons: ["등록", "취소"],
      defaultId: 0,
      cancelId: 1,
      title: "폴더 등록",
      message: "이 폴더의 문서를 검색 가능하게 만듭니다.",
      detail: "원본 파일은 수정되지 않습니다. 답변과 검증을 위해 검색된 문서 일부(evidence)는 설정된 LiteLLM/on-prem 모델로 전송됩니다.",
    });
    assertActive();
    if (consent.response !== 0) return null;

    const taken = new Set(runtime.collections().map((collection) => collection.name));
    const name = collectionNameFor(folder, taken);
    const collection = await runtime.tomato.call("registerCollection", [folder, name, "auto", true], { timeoutMs: TOMATO_LONG_CALL_TIMEOUT_MS });
    // One folder concept for the user: a search folder is also where Excel business tools look for their source files.
    await new WorkSources(runtime.db).register([folder], "folder");
    await runtime.refreshCollections();
    runtime.watchers.watch(collection);
    runtime.watchers.requestSync(name);
    const summaries = await runtime.collectionSummaries("default");
    return summaries.find((summary) => summary.name === name) ?? null;
  });

  handle("collection:remove", async (_event, name: string) => {
    const folder = runtime.collections().find((collection) => collection.name === name)?.path;
    if (folder) { const sources = new WorkSources(runtime.db); const canonical = await realpath(folder).catch(() => folder); for (const source of sources.list()) if (source.kind === "folder" && source.displayPath === canonical) sources.remove(source.id); }
    runtime.watchers.unwatch(name);
    await runtime.tomato.call("remove", [name]);
    await runtime.refreshCollections();
  });

  handle("collection:sync", async (_event, name: string) => {
    const report = await runtime.watchers.syncNow(name);
    return { scanned: report?.scanned ?? 0, updated: report?.updated ?? 0, removed: report?.removed ?? 0, failed: report?.failed.length ?? 0 };
  });
}
