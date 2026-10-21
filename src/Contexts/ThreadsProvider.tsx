import { PropsWithChildren, useCallback, useEffect, useMemo, useState } from "react";
import type { ThreadSummary } from "@app-types/Agent.types";
import { useAgentApi } from "@Features/Agent/hooks/useAgentApi";
import { ThreadsContext } from "./ThreadsContext";

export const WORKSPACE_ID = "default";

/** Agent conversation list shared by the sidebar and the agent page. */
export const ThreadsProvider = ({ children }: PropsWithChildren): React.JSX.Element => {
  const api = useAgentApi();
  const [threads, setThreads] = useState<ThreadSummary[]>([]);

  const refresh = useCallback(async () => {
    if (!api) return;
    setThreads(await api.listThreads(WORKSPACE_ID));
  }, [api]);

  useEffect(() => {
    void refresh();
    // titles and updated_at change when a run settles
    return api?.onAgentEvent((event) => {
      if (event.type === "completed" || event.type === "failed" || event.type === "ask_user") void refresh();
    });
  }, [api, refresh]);

  const createThread = useCallback(async () => {
    if (!api) return null;
    const thread = await api.createThread(WORKSPACE_ID);
    await refresh();
    return thread;
  }, [api, refresh]);

  const renameThread = useCallback(
    async (threadId: string, title: string) => {
      if (!api) return;
      await api.renameThread(threadId, title);
      await refresh();
    },
    [api, refresh],
  );

  const deleteThread = useCallback(
    async (threadId: string) => {
      if (!api) return;
      await api.deleteThread(threadId);
      await refresh();
    },
    [api, refresh],
  );

  const value = useMemo(() => ({ threads, refresh, createThread, renameThread, deleteThread }), [threads, refresh, createThread, renameThread, deleteThread]);
  return <ThreadsContext.Provider value={value}>{children}</ThreadsContext.Provider>;
};
