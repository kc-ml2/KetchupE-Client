import { basename } from "node:path";
import { realpath } from "node:fs/promises";
import { BrowserWindow, dialog, ipcMain } from "electron";
import type { AgentRuntime } from "../agent/runtime.ts";
import { setCollectionActive } from "../agent/store.ts";
import { TOMATO_LONG_CALL_TIMEOUT_MS } from "../tomato/tomatoClient.ts";
import { WorkSources } from "../work/sources.ts";

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function collectionNameFor(folder: string, taken: Set<string>): string {
  const cleaned = basename(folder).normalize("NFKD").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^[-_]+/, "").slice(0, 40);
  const base = NAME_PATTERN.test(cleaned) ? cleaned : `folder-${Date.now().toString(36)}`;
  let name = base;
  for (let suffix = 2; taken.has(name); suffix += 1) name = `${base}-${suffix}`;
  return name;
}

export function registerCollectionHandlers(runtime: AgentRuntime): void {
  ipcMain.handle("collection:list", (_event, workspaceId: string) => runtime.collectionSummaries(workspaceId));
  ipcMain.handle("collection:setActive", (_event, workspaceId: string, name: string, active: boolean) => setCollectionActive(runtime.db, workspaceId, name, active));

  // The renderer never supplies a path: only the native dialog result is registered.
  ipcMain.handle("collection:add", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const picked = window
      ? await dialog.showOpenDialog(window, { properties: ["openDirectory"] })
      : await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (picked.canceled || !picked.filePaths[0]) return null;
    const folder = picked.filePaths[0];
    const consent = await dialog.showMessageBox({
      type: "info",
      buttons: ["등록", "취소"],
      defaultId: 0,
      cancelId: 1,
      title: "폴더 등록",
      message: "이 폴더의 문서를 검색 가능하게 만듭니다.",
      detail: "원본 파일은 수정되지 않습니다. 답변과 검증을 위해 검색된 문서 일부(evidence)는 설정된 LiteLLM/on-prem 모델로 전송됩니다.",
    });
    if (consent.response !== 0) return null;

    const taken = new Set(runtime.collections().map((collection) => collection.name));
    const name = collectionNameFor(folder, taken);
    const collection = await runtime.tomato.call("registerCollection", [folder, name, "auto"], { timeoutMs: TOMATO_LONG_CALL_TIMEOUT_MS });
    // One folder concept for the user: a search folder is also where Excel business tools look for their source files.
    await new WorkSources(runtime.db).register([folder], "folder");
    await runtime.refreshCollections();
    runtime.watchers.watch(collection);
    void runtime.watchers.syncNow(name);
    const summaries = await runtime.collectionSummaries("default");
    return summaries.find((summary) => summary.name === name) ?? null;
  });

  ipcMain.handle("collection:remove", async (_event, name: string) => {
    const folder = runtime.collections().find((collection) => collection.name === name)?.path;
    if (folder) { const sources = new WorkSources(runtime.db); const canonical = await realpath(folder).catch(() => folder); for (const source of sources.list()) if (source.kind === "folder" && source.displayPath === canonical) sources.remove(source.id); }
    runtime.watchers.unwatch(name);
    await runtime.tomato.call("remove", [name]);
    await runtime.refreshCollections();
  });

  ipcMain.handle("collection:sync", async (_event, name: string) => {
    const report = await runtime.watchers.syncNow(name);
    return { scanned: report?.scanned ?? 0, updated: report?.updated ?? 0, removed: report?.removed ?? 0, failed: report?.failed.length ?? 0 };
  });
}
