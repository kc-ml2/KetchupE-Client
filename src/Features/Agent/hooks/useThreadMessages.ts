import { useCallback, useEffect, useState } from "react";
import type { KetchupEAgentAPI, MessageRecord } from "@app-types/Agent.types";

/** Latest 50 messages of one thread plus backwards paging. */
export const useThreadMessages = (api: KetchupEAgentAPI | null, threadId: string | null) => {
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [hasMore, setHasMore] = useState(false);

  const reload = useCallback(async (targetThreadId = threadId) => {
    if (!api || !targetThreadId) {
      setMessages([]);
      setHasMore(false);
      return;
    }
    const page = await api.loadThread(targetThreadId);
    setMessages(page.messages);
    setHasMore(page.hasMore);
  }, [api, threadId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const loadOlder = useCallback(async () => {
    if (!api || !threadId || !messages[0]) return;
    const page = await api.loadThread(threadId, messages[0].id);
    setMessages((current) => [...page.messages, ...current]);
    setHasMore(page.hasMore);
  }, [api, threadId, messages]);

  return { messages, hasMore, reload, loadOlder };
};
