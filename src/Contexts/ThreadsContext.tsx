import { createContext } from "react";
import type { ThreadSummary } from "@app-types/Agent.types";

export type ThreadsContextType = {
  threads: ThreadSummary[];
  refresh: () => Promise<void>;
  createThread: () => Promise<ThreadSummary | null>;
  renameThread: (threadId: string, title: string) => Promise<void>;
  deleteThread: (threadId: string) => Promise<void>;
};

export const ThreadsContext = createContext<ThreadsContextType | null>(null);
