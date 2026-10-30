import { ipcMain, shell } from "electron";
import type { InteractionKind, MemoryInput, StartRunInput } from "../../src/app-types/Agent.types.ts";
import type { AnchorChoiceResumeContent, CanvasEditOp, StartCanvasInput } from "../../src/app-types/CanvasEdit.types.ts";
import type { AgentRuntime } from "../agent/runtime.ts";
import { addMemory, confirmMemory, deleteMemory, listMemories, setMemoryPinned, updateMemory } from "../agent/memory.ts";
import { getRunAction, createThread, deleteThread, findOpenRun, getWorkspace, listThreads, loadThread, recordInteraction, renameThread, setMemoryEnabled, DEFAULT_WORKSPACE_ID } from "../agent/store.ts";

export function registerAgentHandlers(runtime: AgentRuntime, handle: typeof ipcMain.handle = ipcMain.handle.bind(ipcMain), assertActive: () => void = () => undefined): void {
  const { db } = runtime;

  handle("agent:getWorkspace", () => getWorkspace(db, DEFAULT_WORKSPACE_ID));
  handle("agent:setMemoryEnabled", (_event, workspaceId: string, enabled: boolean) => setMemoryEnabled(db, workspaceId, enabled));

  handle("agent:createThread", (_event, workspaceId: string) => createThread(db, workspaceId));
  handle("agent:listThreads", (_event, workspaceId: string) => listThreads(db, workspaceId));
  handle("agent:loadThread", async (_event, threadId: string, beforeMessageId?: string, limit?: number) => {
    await runtime.authorizeThread(threadId);
    assertActive();
    return loadThread(db, threadId, beforeMessageId, limit);
  });
  handle("agent:renameThread", (_event, threadId: string, title: string) => renameThread(db, threadId, title));
  handle("agent:deleteThread", (_event, threadId: string) => deleteThread(db, threadId));
  handle("agent:openRun", (_event, threadId: string) => {
    const run = findOpenRun(db, threadId);
    return run ? { runId: run.id, status: run.status, kind: run.kind, action: getRunAction(db, run.id) } : null;
  });

  handle("canvas:start", async (_event, input: StartCanvasInput) => {
    await runtime.authorizeThread(input.threadId);
    assertActive();
    return { runId: runtime.canvas.start(input).runId };
  });
  handle("canvas:edit", (_event, runId: string, op: CanvasEditOp, displayText?: string) => {
    runtime.canvas.applyEdit(runId, op, displayText);
  });
  handle("canvas:anchorChoice", (_event, runId: string, choice: AnchorChoiceResumeContent) => {
    runtime.canvas.resumeAnchorChoice(runId, choice);
  });
  handle("canvas:load", (_event, runId: string) => runtime.canvas.view(runId));
  handle("canvas:openSource", async (_event, canvasId: string, documentId: string) => {
    const source = runtime.canvas.sourcePath(canvasId, documentId);
    if (!source) throw new Error("source not found");
    const path = await runtime.sourcePath(source);
    assertActive();
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  });

  handle("agent:startRun", (_event, input: StartRunInput) => runtime.startMessage(input));
  handle("agent:resumeRun", (_event, runId: string, text: string) => {
    runtime.resumeRun(runId, text);
  });
  handle("agent:cancelRun", (_event, runId: string) => {
    runtime.cancelRun(runId);
  });
  handle("agent:recordInteraction", (_event, runId: string, kind: InteractionKind) => {
    recordInteraction(db, runId, kind);
    runtime.recordInteractionScore(runId, kind);
  });

  handle("agent:openCitation", async (_event, runId: string, evidenceId: string) => {
    const row = db.prepare("SELECT path FROM citations WHERE run_id = ? AND evidence_id = ?").get(runId, evidenceId) as { path: string } | undefined;
    if (!row) throw new Error("citation not found");
    const path = await runtime.sourcePath(row.path);
    recordInteraction(db, runId, "citation_opened", { evidenceId });
    runtime.recordInteractionScore(runId, "citation_opened");
    assertActive();
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  });

  handle("agent:listMemories", (_event, workspaceId: string) => listMemories(db, workspaceId));
  handle("agent:addMemory", (_event, workspaceId: string, input: MemoryInput) => addMemory(db, workspaceId, input));
  handle("agent:updateMemory", (_event, id: string, input: MemoryInput) => updateMemory(db, id, input));
  handle("agent:setMemoryPinned", (_event, id: string, pinned: boolean) => setMemoryPinned(db, id, pinned));
  handle("agent:confirmMemory", (_event, id: string) => confirmMemory(db, id));
  handle("agent:deleteMemory", (_event, id: string) => deleteMemory(db, id));

  handle("agent:getModelSettings", async () => {
    const settings = runtime.settings();
    const modelAlias = await runtime.resolvedModelAlias().catch(() => settings.modelAlias);
    return { baseURL: settings.baseURL, modelAlias, hasApiKey: Boolean(settings.apiKey), configurable: runtime.modelSelectable };
  });
  handle("agent:listModels", () => runtime.listModels());
  handle("agent:testModelConnection", async () => {
    const models = await runtime.listModels();
    return { ok: models.length > 0, models, resolvedAlias: models.length ? await runtime.resolvedModelAlias() : "" };
  });
  handle("agent:setModelSettings", (_event, settings: { modelAlias: string }) => runtime.updateSettings({ modelAlias: String(settings?.modelAlias ?? "") }));
}
