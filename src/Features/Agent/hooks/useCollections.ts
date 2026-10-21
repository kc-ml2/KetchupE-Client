import { useCallback, useEffect, useState } from "react";
import type { CollectionSummary, KetchupEAgentAPI } from "@app-types/Agent.types";

export const useCollections = (api: KetchupEAgentAPI | null, workspaceId: string) => {
  const [collections, setCollections] = useState<CollectionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      setCollections(await api.listCollections(workspaceId));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [api, workspaceId]);

  useEffect(() => {
    void refresh();
    return api?.onCollectionsChanged(() => void refresh());
  }, [api, refresh]);

  const add = useCallback(async () => {
    if (!api) return;
    try {
      await api.addCollection();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [api, refresh]);

  const remove = useCallback(async (name: string) => { await api?.removeCollection(name); await refresh(); }, [api, refresh]);
  const sync = useCallback(async (name: string) => {
    try {
      await api?.syncCollection(name);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [api, refresh]);
  const setActive = useCallback(async (name: string, active: boolean) => { await api?.setCollectionActive(workspaceId, name, active); await refresh(); }, [api, workspaceId, refresh]);

  return { collections, error, add, remove, sync, setActive };
};
