import { useCallback, useEffect, useState } from "react";
import { LuCloud, LuRefreshCw } from "react-icons/lu";
import type { KetchupEAgentAPI, MaruStorageSummary } from "@app-types/Agent.types";

/** MARU shared storages the logged-in account can read. On by default; checked ones are searched with local folders. */
const MaruStoragePanel = ({
  api,
  workspaceId,
}: {
  api: KetchupEAgentAPI;
  workspaceId: string;
}): React.JSX.Element => {
  const [storages, setStorages] = useState<MaruStorageSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api
      .listMaruStorages(workspaceId)
      .then(setStorages)
      .catch(() => setError("공유 저장소 목록을 불러오지 못했습니다. 연결 상태를 확인해 주세요."));
  }, [api, workspaceId]);

  useEffect(load, [load]);

  const toggle = async (storageId: string, active: boolean) => {
    setStorages((current) => current?.map((storage) => (storage.storageId === storageId ? { ...storage, active } : storage)) ?? null);
    try {
      await api.setMaruStorageActive(workspaceId, storageId, active);
    } catch {
      load();
    }
  };

  return (
    <section className="mt-6 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-[#18181B] dark:text-[#FAFAFA]">
          <LuCloud className="h-4 w-4" />
          공유 저장소
        </h3>
        <button type="button" title="목록 새로고침" onClick={load} className="text-[#71717A] hover:text-[#0066FF]">
          <LuRefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>
      <p className="text-[11px] leading-relaxed text-[#71717A]">
        체크한 저장소는 질문할 때 로컬 폴더와 함께 검색합니다. 체크를 해제해도 질문에 &lsquo;공유 저장소&rsquo;를
        언급하면 접근 가능한 전체 저장소에서 찾습니다. 파일명·본문 키워드가 일치하는 문서만 찾습니다.
      </p>
      {error && <p className="text-xs text-[#DC2626]">{error}</p>}
      {!error && storages === null && <p className="text-xs text-[#71717A]">불러오는 중…</p>}
      {storages?.length === 0 && <p className="text-xs text-[#71717A]">접근 가능한 저장소가 없습니다.</p>}
      {storages?.map((storage) => (
        <label
          key={storage.storageId}
          className="flex items-center gap-2 p-3 rounded-lg border border-[#E4E4E7] dark:border-[#27272A] text-sm"
        >
          <input
            type="checkbox"
            checked={storage.active}
            onChange={(event) => void toggle(storage.storageId, event.target.checked)}
          />
          <span className="flex-1 font-semibold truncate text-[#18181B] dark:text-[#FAFAFA]" title={storage.storageId}>
            {storage.name}
          </span>
        </label>
      ))}
    </section>
  );
};

export default MaruStoragePanel;
