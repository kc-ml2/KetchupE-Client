import type { DatabaseSync } from "node:sqlite";
import type { SelectedMemory } from "./contracts.ts";
import { pinnedMemories, searchConfirmedMemories } from "./memory.ts";
import { getWorkspace, recentMessages } from "./store.ts";
import { estimateTokens } from "../tomato/text.ts";

export const MEMORY_CONTEXT_TOKEN_LIMIT = 1500;
export const RECENT_MESSAGE_COUNT = 12;
export const MEMORY_SEARCH_LIMIT = 5;

export type ContextSelection = {
  memories: SelectedMemory[];
  recentMessages: Array<{ id: string; role: "user" | "assistant"; content: string }>;
  selected: { memoryIds: string[]; excludedMemoryIds: string[]; messageIds: string[] };
  tokenEstimate: number;
  contextText: string;
};

/** Deterministic order: pinned memories → FTS memories → recent messages. */
export function selectContext(
  db: DatabaseSync,
  input: { workspaceId: string; threadId: string; userGoal: string; excludeMessageId?: string },
): ContextSelection {
  const workspace = getWorkspace(db, input.workspaceId);
  const seen = new Set<string>();
  const candidates = workspace.memoryEnabled
    ? [...pinnedMemories(db, input.workspaceId), ...searchConfirmedMemories(db, input.workspaceId, input.userGoal, MEMORY_SEARCH_LIMIT)]
    : [];
  const uniqueCandidates = candidates
    .filter((memory) => !seen.has(memory.id) && seen.add(memory.id));

  let budget = MEMORY_CONTEXT_TOKEN_LIMIT;
  const memories: SelectedMemory[] = [];
  const excludedMemoryIds: string[] = [];
  for (const memory of uniqueCandidates) {
    const cost = estimateTokens(memory.content);
    if (cost > budget) {
      excludedMemoryIds.push(memory.id);
      continue;
    }
    budget -= cost;
    memories.push({ id: memory.id, kind: memory.kind, content: memory.content });
  }

  const messages = recentMessages(db, input.threadId, RECENT_MESSAGE_COUNT, input.excludeMessageId)
    .map((message) => ({ id: message.id, role: message.role, content: message.content }));

  const contextText = [
    memories.length ? `memories:\n${memories.map((memory) => `- (${memory.kind}) ${memory.content}`).join("\n")}` : undefined,
    messages.length ? `recentMessages:\n${messages.map((message) => `${message.role}: ${message.content}`).join("\n")}` : undefined,
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    memories,
    recentMessages: messages,
    selected: { memoryIds: memories.map((memory) => memory.id), excludedMemoryIds, messageIds: messages.map((message) => message.id) },
    tokenEstimate: estimateTokens(contextText),
    contextText,
  };
}
