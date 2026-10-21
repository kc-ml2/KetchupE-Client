import { copyFile, realpath } from "node:fs/promises";
import { basename, extname } from "node:path";
import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { z } from "zod";
import type { AgentRuntime } from "../agent/runtime.ts";
import type { ExtractionPreview, SourceMapping, SourceProfile, WorkFile } from "../../src/app-types/WorkSource.types.ts";
import { WorkSources } from "../work/sources.ts";
import { listProfiles, profileSchema, saveProfile } from "../work/profiles.ts";
import { mappingSchema } from "../work/mapping.ts";
import { readWorkbookJob, type WorkbookJob } from "../work/reader.ts";

const fileSchema = z.object({ sourceId: z.string().min(1).max(100), relativePath: z.string().max(4096), name: z.string().max(500) }).strict();
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);

export function registerWorkSourceHandlers(runtime: AgentRuntime, workerPath: string): void {
  ipcMain.handle("business:submit", (_event, runId: unknown, actionId: unknown, input: unknown) => runtime.businessFlow.submit(z.string().min(1).parse(runId), z.string().min(1).parse(actionId), input));
  ipcMain.handle("business:artifacts", (_event, threadId: unknown) => runtime.businessFlow.artifacts(z.string().min(1).parse(threadId)));
  ipcMain.handle("business:openArtifact", async (_event, id: unknown) => {
    const path = await runtime.businessFlow.artifactPath(z.string().uuid().parse(id));
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  });
  ipcMain.handle("business:saveArtifact", async (event, rawId: unknown) => {
    const id = z.string().uuid().parse(rawId);
    const path = await runtime.businessFlow.artifactPath(id);
    const owner = BrowserWindow.fromWebContents(event.sender);
    const extension = extname(path).slice(1);
    const options: Electron.SaveDialogOptions = { title: "결과 파일 저장", defaultPath: basename(path), filters: [{ name: extension.toUpperCase(), extensions: [extension] }] };
    const picked = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
    if (picked.canceled || !picked.filePath) return false;
    await copyFile(await runtime.businessFlow.artifactPath(id), picked.filePath);
    return true;
  });
  const sources = new WorkSources(runtime.db);
  let reading = false;
  const read = async (file: WorkFile, action: WorkbookJob["action"], expected?: string) => {
    fileSchema.parse(file);
    if (reading) throw new Error("다른 엑셀을 읽고 있습니다. 잠시 후 다시 시도해 주세요.");
    reading = true;
    try {
      const { bytes, fingerprint } = await sources.read(file);
      if (expected && fingerprint !== fingerprintSchema.parse(expected)) throw new Error("원본 파일이 변경되었습니다. 원본 다시 읽기로 내용을 확인한 뒤 다시 검증해 주세요.");
      const result = await readWorkbookJob(workerPath, { bytes, fingerprint, action });
      if (!sources.list().some((source) => source.id === file.sourceId)) throw new Error("자료 연결이 해제되었습니다.");
      return result;
    } finally { reading = false; }
  };
  ipcMain.handle("work:submitSelection", async (_event, rawRunId: unknown, rawActionId: unknown, rawSelection: unknown) => {
    const runId = z.string().min(1).parse(rawRunId);
    const actionId = z.string().min(1).parse(rawActionId);
    const selection = z.object({ file: fileSchema, fingerprint: fingerprintSchema, profileId: z.string().min(1), profileRevision: z.number().int().positive() }).strict().parse(rawSelection);
    runtime.workSourcesFlow.checkRequest(runId, actionId);
    const profile = listProfiles(runtime.db).find((item) => item.id === selection.profileId);
    if (!profile || profile.revision !== selection.profileRevision) throw new Error("매핑이 변경되었습니다. 다시 불러와 확인해 주세요.");
    const result = await read(selection.file, { kind: "extract", mapping: profile.mapping }, selection.fingerprint) as ExtractionPreview;
    if (listProfiles(runtime.db).find((item) => item.id === profile.id)?.revision !== profile.revision) throw new Error("검증 중 매핑이 변경되었습니다.");
    runtime.workSourcesFlow.complete(runId, actionId, selection, result);
  });
  ipcMain.handle("work:listSources", () => sources.list());
  ipcMain.handle("work:pickSources", async (event, rawKind: unknown) => {
    const kind = z.enum(["file", "folder"]).parse(rawKind);
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = kind === "folder"
      ? { properties: ["openDirectory"], title: "참고할 업무 폴더 선택" }
      : { properties: ["openFile", "multiSelections"], filters: [{ name: "Excel", extensions: ["xlsx"] }], title: "참고할 업무 파일 선택" };
    const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return picked.canceled ? sources.list() : sources.register(picked.filePaths, kind);
  });
  ipcMain.handle("work:pickFiles", async (event, rawMultiple: unknown) => {
    const multiple = z.boolean().parse(rawMultiple);
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = { properties: multiple ? ["openFile", "multiSelections"] : ["openFile"], filters: [{ name: "Excel", extensions: ["xlsx"] }], title: "업무 파일 선택" };
    const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (picked.canceled) return [];
    const registered = await sources.register(picked.filePaths, "file");
    const paths = await Promise.all(picked.filePaths.map((path) => realpath(path)));
    return paths.flatMap((path) => registered.filter((source) => source.kind === "file" && source.displayPath === path)
      .map((source): WorkFile => ({ sourceId: source.id, relativePath: "", name: source.name })));
  });
  ipcMain.handle("work:removeSource", (_event, id: string) => sources.remove(z.string().parse(id)));
  ipcMain.handle("work:listFiles", (_event, id: string) => sources.files(z.string().parse(id)));
  ipcMain.handle("work:inspect", (_event, file: WorkFile, sheet?: string, headerRow?: number) => read(file, { kind: "inspect", sheet: z.string().max(100).optional().parse(sheet), headerRow: z.number().int().min(1).max(100000).optional().parse(headerRow) }));
  ipcMain.handle("work:preview", (_event, file: WorkFile, fingerprint: string, mapping: SourceMapping) => {
    fingerprintSchema.parse(fingerprint);
    return read(file, { kind: "extract", mapping: mappingSchema.parse(mapping) }, fingerprint);
  });
  ipcMain.handle("work:listProfiles", () => listProfiles(runtime.db));
  ipcMain.handle("work:saveProfile", async (_event, file: WorkFile, fingerprint: string, input: SourceProfile) => {
    fingerprintSchema.parse(fingerprint);
    const profile = profileSchema.parse(input);
    const result = await read(file, { kind: "extract", mapping: profile.mapping }, fingerprint) as ExtractionPreview;
    if (result.issueCount || !result.matchedRows) throw new Error("추출 오류를 해결하고 대상 행이 있는지 확인한 뒤 저장해 주세요.");
    return saveProfile(runtime.db, profile, fingerprint);
  });
  ipcMain.handle("work:removeProfile", (_event, id: string) => { runtime.db.prepare("DELETE FROM source_profiles WHERE id = ?").run(z.string().parse(id)); });
}
