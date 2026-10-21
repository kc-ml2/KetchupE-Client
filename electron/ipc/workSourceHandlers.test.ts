import { WorkSourcesFlow } from "../agent/workSourcesFlow.ts";
import { createThread, ensureWorkspace, getRun, getRunAction } from "../agent/store.ts";
// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openAgentDb } from "../db/openAgentDb.ts";
import { extractRows, inspectWorkbook, loadWorkbook } from "../work/mapping.ts";
import type { WorkbookJob } from "../work/reader.ts";
import type { AgentRuntime } from "../agent/runtime.ts";
import type { SourceProfile } from "../../src/app-types/WorkSource.types.ts";

const mock = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), paths: [] as string[], read: vi.fn(), save: vi.fn(), artifactPath: vi.fn() }));
vi.mock("electron", () => ({ ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => mock.handlers.set(name, handler) }, BrowserWindow: { fromWebContents: () => null }, dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: mock.paths }), showSaveDialog: mock.save } }));
vi.mock("../work/reader.ts", () => ({ readWorkbookJob: mock.read }));
import { registerWorkSourceHandlers } from "./workSourceHandlers.ts";

let flow: WorkSourcesFlow;
let folder: string; let db: ReturnType<typeof openAgentDb>;
const invoke = (name: string, ...args: unknown[]) => mock.handlers.get(`work:${name}`)!({ sender: {} }, ...args);
const profile: SourceProfile = { id: "", name: "입출금", revision: 0, mapping: { sheet: "자료", headerRow: 1, firstDataRow: 2, columns: [{ field: "accountId", header: "계좌", type: "text", required: true }], filters: [] } };
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "work-ipc-")); db = openAgentDb(":memory:");
  const workbook = new ExcelJS.Workbook(); workbook.addWorksheet("자료").addRows([["계좌"], ["00123"]]);
  const path = join(folder, "source.xlsx"); await writeFile(path, Buffer.from(await workbook.xlsx.writeBuffer())); mock.paths = [path];
  mock.read.mockImplementation(async (_path: string, job: WorkbookJob) => {
    const book = await loadWorkbook(job.bytes);
    return job.action.kind === "inspect" ? inspectWorkbook(book, job.fingerprint, job.action.sheet, job.action.headerRow) : extractRows(book, job.fingerprint, job.action.mapping);
  });
  flow = new WorkSourcesFlow(db, () => undefined);
  registerWorkSourceHandlers({ db, workSourcesFlow: flow, businessFlow: { artifactPath: mock.artifactPath } } as unknown as AgentRuntime, "worker");
});
afterEach(async () => { db.close(); mock.handlers.clear(); mock.read.mockReset(); mock.save.mockReset(); mock.artifactPath.mockReset(); await rm(folder, { recursive: true, force: true }); });

const artifactId = "9b3bb758-a5cb-4eda-87b3-28bac9b487e2";
const saveArtifact = (id = artifactId) => mock.handlers.get("business:saveArtifact")!({ sender: {} }, id);
it("saves the verified PNG to the native dialog destination with its original filename", async () => {
  const source = join(folder, "일일자금일보_261015.png"); const destination = join(folder, "saved.png");
  const bytes = await (await import("sharp")).default({ create: { width: 1, height: 1, channels: 4, background: "white" } }).png().toBuffer();
  await writeFile(source, bytes);
  mock.artifactPath.mockResolvedValue(source);
  mock.save.mockResolvedValue({ canceled: false, filePath: destination });
  expect(await saveArtifact()).toBe(true);
  expect(mock.save).toHaveBeenCalledWith({ title: "결과 파일 저장", defaultPath: "일일자금일보_261015.png", filters: [{ name: "PNG", extensions: ["png"] }] });
  expect(await readFile(destination)).toEqual(bytes);
  expect(await readFile(source)).toEqual(bytes);
  expect(mock.artifactPath).toHaveBeenNthCalledWith(2, artifactId);
});
it("does not write a file when saving is canceled", async () => {
  const destination = join(folder, "saved.png");
  mock.artifactPath.mockResolvedValue(join(folder, "report.png"));
  mock.save.mockResolvedValue({ canceled: true, filePath: destination });
  expect(await saveArtifact()).toBe(false);
  expect(mock.artifactPath).toHaveBeenCalledTimes(1);
  await expect(readFile(destination)).rejects.toThrow();
});
it("rejects renderer paths and unavailable artifacts before showing the save dialog", async () => {
  await expect(saveArtifact("/tmp/report.png")).rejects.toThrow();
  expect(mock.artifactPath).not.toHaveBeenCalled();
  mock.artifactPath.mockRejectedValue(new Error("완료된 결과 파일이 없습니다."));
  await expect(saveArtifact()).rejects.toThrow("완료된 결과 파일");
  expect(mock.save).not.toHaveBeenCalled();
});
it("rechecks the artifact after the dialog and preserves the destination on validation failure", async () => {
  const destination = join(folder, "saved.png"); await writeFile(destination, "existing");
  mock.artifactPath.mockResolvedValueOnce(join(folder, "report.png")).mockRejectedValueOnce(new Error("결과 파일이 변경되었습니다."));
  mock.save.mockResolvedValue({ canceled: false, filePath: destination });
  await expect(saveArtifact()).rejects.toThrow("결과 파일이 변경");
  expect(await readFile(destination, "utf8")).toBe("existing");
});
it("propagates a copy failure instead of reporting a successful save", async () => {
  mock.artifactPath.mockResolvedValue(mock.paths[0]);
  mock.save.mockResolvedValue({ canceled: false, filePath: join(folder, "missing", "saved.png") });
  await expect(saveArtifact()).rejects.toThrow();
});

it("connects a native selection through inspection, validated extraction and persisted profile", async () => {
  const [source] = await invoke("pickSources", "file");
  const [file] = await invoke("listFiles", source.id);
  const overview = await invoke("inspect", file);
  expect((await invoke("preview", file, overview.fingerprint, profile.mapping)).matchedRows).toBe(1);
  const saved = await invoke("saveProfile", file, overview.fingerprint, profile);
  expect(invoke("listProfiles")).toEqual([saved]);
  await writeFile(mock.paths[0], "changed");
  await expect(invoke("saveProfile", file, overview.fingerprint, saved)).rejects.toThrow("원본 파일이 변경");
  expect(invoke("listProfiles")[0].revision).toBe(1);
});

it("does not save a profile with missing required data or no matched rows", async () => {
  const [source] = await invoke("pickSources", "file"); const [file] = await invoke("listFiles", source.id); const overview = await invoke("inspect", file);
  const empty = { ...profile, mapping: { ...profile.mapping, filters: [{ field: "accountId", operator: "equals", value: "missing" }] } };
  await expect(invoke("saveProfile", file, overview.fingerprint, empty)).rejects.toThrow("대상 행");
  expect(invoke("listProfiles")).toEqual([]);
});

it("continues the owning workflow only with a current file, mapping and action", async () => {
  const workspace = ensureWorkspace(db);
  const thread = createThread(db, workspace.id);
  const { runId } = flow.start({ threadId: thread.id, workspaceId: workspace.id, text: "일일자금일보 작성" }, "daily_cash");
  const action = getRunAction(db, runId)!;
  const [source] = await invoke("pickSources", "file"); const [file] = await invoke("listFiles", source.id);
  const overview = await invoke("inspect", file);
  const saved = await invoke("saveProfile", file, overview.fingerprint, profile);
  const selection = { file, fingerprint: overview.fingerprint, profileId: saved.id, profileRevision: saved.revision };
  await expect(invoke("submitSelection", runId, "stale", selection)).rejects.toThrow("변경된 입력");
  await expect(invoke("submitSelection", runId, action.id, { ...selection, profileRevision: 2 })).rejects.toThrow("매핑이 변경");
  await invoke("submitSelection", runId, action.id, selection);
  expect(getRun(db, runId).status).toBe("abstained");
  expect(getRunAction(db, runId)).toBeUndefined();
  await expect(invoke("submitSelection", runId, action.id, selection)).rejects.toThrow("변경된 입력");
});
it("rejects completion after cancellation while the workbook is being read", async () => {
  const workspace = ensureWorkspace(db); const thread = createThread(db, workspace.id);
  const { runId } = flow.start({ threadId: thread.id, workspaceId: workspace.id, text: "연결" }, "work_sources");
  const action = getRunAction(db, runId)!;
  const [source] = await invoke("pickSources", "file"); const [file] = await invoke("listFiles", source.id);
  const overview = await invoke("inspect", file); const saved = await invoke("saveProfile", file, overview.fingerprint, profile);
  const implementation = mock.read.getMockImplementation()!;
  mock.read.mockImplementationOnce(async (...args) => { flow.cancel(runId); return implementation(...args); });
  await expect(invoke("submitSelection", runId, action.id, { file, fingerprint: overview.fingerprint, profileId: saved.id, profileRevision: saved.revision })).rejects.toThrow("변경된 입력");
  expect(getRun(db, runId).status).toBe("cancelled");
});
it("returns only the files chosen in the dialog, even when others are already connected", async () => {
  const other = join(folder, "other.xlsx"); await writeFile(other, await readFile(mock.paths[0]));
  mock.paths = [other]; await invoke("pickSources", "file");
  mock.paths = [join(folder, "source.xlsx"), other];
  expect((await invoke("pickFiles", true)).map((file: { name: string }) => file.name)).toEqual(["source.xlsx", "other.xlsx"]);
  expect(invoke("listSources")).toHaveLength(2);
});
