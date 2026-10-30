import { useCallback, useEffect, useRef, useState } from "react";
import type { KetchupEAgentAPI, MessageRecord } from "@app-types/Agent.types";

/** Latest 50 messages of one thread plus backwards paging. */
export const useThreadMessages = (api: KetchupEAgentAPI | null, threadId: string | null) => {
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const request = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  const reload = useCallback(async (targetThreadId = threadId) => {
    if (!api || !targetThreadId) {
      setMessages([]);
      setHasMore(false);
      return;
    }
    const id = ++request.current;
    try {
      const page = await api.loadThread(targetThreadId);
      if (id !== request.current) return;
      setError(null);
      setMessages(page.messages);
      setHasMore(page.hasMore);
    } catch {
      if (id !== request.current) return;
      setMessages([]);
      setHasMore(false);
      setError("대화를 불러오지 못했습니다. 연결 상태와 MARU 문서 접근 권한을 확인해 주세요.");
    }
  }, [api, threadId]);

  useEffect(() => {
    setMessages([]);
    setHasMore(false);
    setError(null);
    void reload();
    return () => { request.current += 1; };
  }, [reload]);

  const loadOlder = useCallback(async () => {
    if (!api || !threadId || !messages[0]) return;
    const id = ++request.current;
    try {
      const page = await api.loadThread(threadId, messages[0].id);
      if (id !== request.current) return;
      setMessages((current) => [...page.messages, ...current]);
      setHasMore(page.hasMore);
    } catch {
      if (id !== request.current) return;
      setMessages([]);
      setHasMore(false);
      setError("이전 대화의 접근 권한을 확인하지 못했습니다.");
    }
  }, [api, threadId, messages]);

  return { messages, hasMore, reload, loadOlder, error };
};
