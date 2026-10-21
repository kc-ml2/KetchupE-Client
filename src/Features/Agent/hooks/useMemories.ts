import { useCallback, useEffect, useState } from "react";
import type { KetchupEAgentAPI, Memory, MemoryInput } from "@app-types/Agent.types";

export const useMemories = (api: KetchupEAgentAPI | null, workspaceId: string) => {
  const [memories, setMemories] = useState<Memory[]>([]);
  const refresh = useCallback(async () => {
    if (api) setMemories(await api.listMemories(workspaceId));
  }, [api, workspaceId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const add = useCallback(async (input: MemoryInput) => { await api?.addMemory(workspaceId, input); await refresh(); }, [api, workspaceId, refresh]);
  const update = useCallback(async (id: string, input: MemoryInput) => { await api?.updateMemory(id, input); await refresh(); }, [api, refresh]);
  const setPinned = useCallback(async (id: string, pinned: boolean) => { await api?.setMemoryPinned(id, pinned); await refresh(); }, [api, refresh]);
  const confirm = useCallback(async (id: string) => { await api?.confirmMemory(id); await refresh(); }, [api, refresh]);
  const remove = useCallback(async (id: string) => { await api?.deleteMemory(id); await refresh(); }, [api, refresh]);
  return { memories, refresh, add, update, setPinned, confirm, remove };
};
