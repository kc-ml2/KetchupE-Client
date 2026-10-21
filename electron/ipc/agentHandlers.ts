import { app, ipcMain, shell } from "electron";
import type { InteractionKind, MemoryInput, StartRunInput } from "../../src/app-types/Agent.types.ts";
import type { AnchorChoiceResumeContent, CanvasEditOp, StartCanvasInput } from "../../src/app-types/CanvasEdit.types.ts";
import type { AgentRuntime } from "../agent/runtime.ts";
import { addMemory, confirmMemory, deleteMemory, listMemories, setMemoryPinned, updateMemory } from "../agent/memory.ts";
import { getRunAction, createThread, deleteThread, findOpenRun, getWorkspace, listThreads, loadThread, recordInteraction, renameThread, setMemoryEnabled, DEFAULT_WORKSPACE_ID } from "../agent/store.ts";

export function registerAgentHandlers(runtime: AgentRuntime): void {
  const { db } = runtime;

  ipcMain.handle("agent:getWorkspace", () => getWorkspace(db, DEFAULT_WORKSPACE_ID));
  ipcMain.handle("agent:setMemoryEnabled", (_event, workspaceId: string, enabled: boolean) => setMemoryEnabled(db, workspaceId, enabled));

  ipcMain.handle("agent:createThread", (_event, workspaceId: string) => createThread(db, workspaceId));
  ipcMain.handle("agent:listThreads", (_event, workspaceId: string) => listThreads(db, workspaceId));
  ipcMain.handle("agent:loadThread", (_event, threadId: string, beforeMessageId?: string, limit?: number) => loadThread(db, threadId, beforeMessageId, limit));
  ipcMain.handle("agent:renameThread", (_event, threadId: string, title: string) => renameThread(db, threadId, title));
  ipcMain.handle("agent:deleteThread", (_event, threadId: string) => deleteThread(db, threadId));
  ipcMain.handle("agent:openRun", (_event, threadId: string) => {
    const run = findOpenRun(db, threadId);
    return run ? { runId: run.id, status: run.status, kind: run.kind, action: getRunAction(db, run.id) } : null;
  });

  ipcMain.handle("canvas:start", (_event, input: StartCanvasInput) => ({ runId: runtime.canvas.start(input).runId }));
  ipcMain.handle("canvas:edit", (_event, runId: string, op: CanvasEditOp, displayText?: string) => {
    runtime.canvas.applyEdit(runId, op, displayText);
  });
  ipcMain.handle("canvas:anchorChoice", (_event, runId: string, choice: AnchorChoiceResumeContent) => {
    runtime.canvas.resumeAnchorChoice(runId, choice);
  });
  ipcMain.handle("canvas:load", (_event, runId: string) => runtime.canvas.view(runId));
  ipcMain.handle("canvas:openSource", async (_event, canvasId: string, documentId: string) => {
    const path = runtime.canvas.sourcePath(canvasId, documentId);
    if (!path) throw new Error("source not found");
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  });

  ipcMain.handle("agent:startRun", (_event, input: StartRunInput) => runtime.startMessage(input));
  ipcMain.handle("agent:resumeRun", (_event, runId: string, text: string) => {
    runtime.resumeRun(runId, text);
  });
  ipcMain.handle("agent:cancelRun", (_event, runId: string) => {
    runtime.cancelRun(runId);
  });
  ipcMain.handle("agent:recordInteraction", (_event, runId: string, kind: InteractionKind) => {
    recordInteraction(db, runId, kind);
    runtime.recordInteractionScore(runId, kind);
  });

  ipcMain.handle("agent:openCitation", async (_event, runId: string, evidenceId: string) => {
    const row = db.prepare("SELECT path FROM citations WHERE run_id = ? AND evidence_id = ?").get(runId, evidenceId) as { path: string } | undefined;
    if (!row) throw new Error("citation not found");
    recordInteraction(db, runId, "citation_opened", { evidenceId });
    runtime.recordInteractionScore(runId, "citation_opened");
    const error = await shell.openPath(row.path);
    if (error) throw new Error(error);
  });

  ipcMain.handle("agent:listMemories", (_event, workspaceId: string) => listMemories(db, workspaceId));
  ipcMain.handle("agent:addMemory", (_event, workspaceId: string, input: MemoryInput) => addMemory(db, workspaceId, input));
  ipcMain.handle("agent:updateMemory", (_event, id: string, input: MemoryInput) => updateMemory(db, id, input));
  ipcMain.handle("agent:setMemoryPinned", (_event, id: string, pinned: boolean) => setMemoryPinned(db, id, pinned));
  ipcMain.handle("agent:confirmMemory", (_event, id: string) => confirmMemory(db, id));
  ipcMain.handle("agent:deleteMemory", (_event, id: string) => deleteMemory(db, id));

  ipcMain.handle("agent:getModelSettings", () => {
    const settings = runtime.settings();
    return { baseURL: settings.baseURL, modelAlias: settings.modelAlias, hasApiKey: Boolean(settings.apiKey), configurable: !app.isPackaged };
  });
  ipcMain.handle("agent:listModels", () => runtime.listModels());
  ipcMain.handle("agent:testModelConnection", async () => {
    const models = await runtime.listModels();
    return { ok: models.length > 0, models, resolvedAlias: models.length ? await runtime.resolvedModelAlias() : "" };
  });
  ipcMain.handle("agent:setModelSettings", (_event, settings: { baseURL: string; modelAlias: string; apiKey?: string }) => runtime.updateSettings(settings));
}
