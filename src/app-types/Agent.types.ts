import type { BusinessAction, BusinessToolAPI } from "./BusinessTool.types";
// Renderer-facing IPC contract. Type-only; shared with electron/ via `import type`.
import type { ContractCanvas } from "./Canvas.types";
import type { WorkSourceAPI } from "./WorkSource.types";
import type { AnchorChoiceResumeContent, CanvasEditOp, CanvasInterrupt, StartCanvasInput } from "./CanvasEdit.types";

export type ThreadSummary = {
  id: string;
  workspaceId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type MessageRecord = {
  id: string;
  threadId: string;
  runId: string | null;
  role: "user" | "assistant";
  content: string;
  citations: CitationSummary[];
  appliedContext: AppliedContext;
  createdAt: string;
};

export type MessagePage = { messages: MessageRecord[]; hasMore: boolean };

export type RunStatus = "running" | "waiting_user" | "completed" | "abstained" | "failed" | "cancelled";

export type AgentStreamEventType = "status" | "text_delta" | "ask_user" | "citation" | "completed" | "failed" | "canvas";

export type CitationSummary = {
  evidenceId: string;
  title: string;
  breadcrumb: string[];
  page?: number;
};

export type AgentStreamEvent = {
  runId: string;
  seq: number;
  type: AgentStreamEventType;
  payload: unknown;
};

/** auto (default) routes the message; any other mode selects a registered workflow ID. */
export type StartRunInput = { threadId: string; workspaceId: string; text: string; mode?: string };
/** Persisted workflow kind; built-ins are agent and canvas. */
export type RunKind = string;
export type RunAction = { id: string; type: "work_sources"; title: string; question: string } | BusinessAction;
export type StartRunResult = { runId: string; kind: RunKind; action?: RunAction; status?: RunStatus };

export type CollectionSummary = {
  name: string;
  path: string;
  active: boolean;
  sources: number;
  chunks: number;
  embedded: number;
  syncing: boolean;
  lastError?: string;
};

export type SyncSummary = { scanned: number; updated: number; removed: number; failed: number };

export type MemoryKind = "preference" | "fact" | "task";
export type MemoryStatus = "pending" | "confirmed";
export type Memory = {
  id: string;
  workspaceId: string;
  kind: MemoryKind;
  content: string;
  status: MemoryStatus;
  pinned: boolean;
  createdAt: string;
};

export type MemoryInput = {
  kind: MemoryKind;
  content: string;
  pinned: boolean;
};

export type AppliedContext = {
  workspaceInstruction?: string;
  memories: Array<Pick<Memory, "id" | "kind" | "content">>;
};

export type InteractionKind =
  | "accepted"
  | "retried"
  | "corrected"
  | "citation_opened"
  | "clarification_answered"
  | "abandoned"
  | "memory_confirmed"
  | "memory_rejected";

export type WorkspaceSummary = { id: string; name: string; memoryEnabled: boolean };

export interface KetchupEAgentAPI extends WorkSourceAPI, BusinessToolAPI {
  getWorkspace(): Promise<WorkspaceSummary>;
  setMemoryEnabled(workspaceId: string, enabled: boolean): Promise<void>;

  createThread(workspaceId: string): Promise<ThreadSummary>;
  listThreads(workspaceId: string): Promise<ThreadSummary[]>;
  loadThread(threadId: string, beforeMessageId?: string, limit?: number): Promise<MessagePage>;
  renameThread(threadId: string, title: string): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
  openRun(threadId: string): Promise<{ runId: string; status: RunStatus; kind: RunKind; action?: RunAction } | null>;

  startRun(input: StartRunInput): Promise<StartRunResult>;
  resumeRun(runId: string, text: string): Promise<void>;
  cancelRun(runId: string): Promise<void>;
  onAgentEvent(listener: (event: AgentStreamEvent) => void): () => void;
  recordInteraction(runId: string, kind: InteractionKind): Promise<void>;
  openCitation(runId: string, evidenceId: string): Promise<void>;

  addCollection(): Promise<CollectionSummary | null>;
  removeCollection(name: string): Promise<void>;
  syncCollection(name: string): Promise<SyncSummary>;
  listCollections(workspaceId: string): Promise<CollectionSummary[]>;
  setCollectionActive(workspaceId: string, name: string, active: boolean): Promise<void>;
  onCollectionsChanged(listener: () => void): () => void;

  listMemories(workspaceId: string): Promise<Memory[]>;
  addMemory(workspaceId: string, input: MemoryInput): Promise<void>;
  updateMemory(id: string, input: MemoryInput): Promise<void>;
  setMemoryPinned(id: string, pinned: boolean): Promise<void>;
  confirmMemory(id: string): Promise<void>;
  deleteMemory(id: string): Promise<void>;

  getModelSettings(): Promise<{ baseURL: string; modelAlias: string; hasApiKey: boolean; configurable: boolean }>;
  setModelSettings(settings: { baseURL: string; modelAlias: string; apiKey?: string }): Promise<void>;
  listModels(): Promise<string[]>;
  testModelConnection(): Promise<{ ok: boolean; models: string[]; resolvedAlias: string }>;

  // Document authoring (canvas): one run per document, paused between edits.
  startCanvas(input: StartCanvasInput): Promise<{ runId: string }>;
  canvasEdit(runId: string, op: CanvasEditOp, displayText?: string): Promise<void>;
  canvasAnchorChoice(runId: string, choice: AnchorChoiceResumeContent): Promise<void>;
  loadCanvas(runId: string): Promise<{ canvas: ContractCanvas | null; interrupt: CanvasInterrupt | null }>;
  openCanvasSource(canvasId: string, documentId: string): Promise<void>;

}
