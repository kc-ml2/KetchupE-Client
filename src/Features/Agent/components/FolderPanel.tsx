import { useEffect, useRef, useState, type ReactNode } from "react";
import { LuArrowLeft, LuCheck, LuMinus, LuCloud, LuFile, LuFolder, LuFolderPlus, LuRefreshCw, LuSearch, LuCircleAlert, LuX } from "react-icons/lu";
import type { CollectionSummary, FolderEntry, FolderListing, FolderLocation, KetchupEAgentAPI, MaruStorageSummary } from "@app-types/Agent.types";

type Props = {
  api: KetchupEAgentAPI;
  workspaceId: string;
  collections: CollectionSummary[];
  error: string | null;
  onAdd: () => void;
  onRemove: (name: string) => Promise<void>;
  onSync: (name: string) => Promise<void>;
};
type Location = FolderLocation & { name: string };
const button = "rounded-lg px-3 py-2 text-xs text-[#52525B] hover:bg-[#F4F4F5] dark:text-[#A1A1AA] dark:hover:bg-[#27272A] disabled:opacity-40";
const grid = "grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4";

function FolderCounts({ searchable, failed }: { searchable: number; failed: number }) {
  return <span className="inline-flex items-center gap-3">
    <span className="inline-flex items-center gap-1" aria-label={`검색 가능한 문서 ${searchable}개`}><LuSearch aria-hidden className="h-3 w-3" />{searchable}</span>
    <span className={`inline-flex items-center gap-1 ${failed ? "text-red-600 dark:text-red-400" : ""}`} aria-label={`오류 문서 ${failed}개`}><LuCircleAlert aria-hidden className="h-3 w-3" />{failed}</span>
  </span>;
}

function Tile({ name, folder = true, remote = false, detail, error, status, selected, onClick }: { name: string; folder?: boolean; remote?: boolean; detail?: ReactNode; error?: string; status?: FolderEntry["searchStatus"]; selected?: boolean; onClick: () => void }) {
  const badge = `absolute -bottom-1 -right-2 flex h-6 w-6 items-center justify-center rounded-full border-2 border-white text-white dark:border-[#18181B] `;
  return <button type="button" onClick={onClick} draggable={false} aria-pressed={selected} className={`group flex h-44 select-none flex-col items-center justify-start gap-2 rounded-xl border p-3 text-center outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${selected ? "border-blue-400 bg-blue-50 dark:border-blue-500 dark:bg-blue-950/50" : "border-transparent bg-transparent hover:bg-zinc-100 dark:hover:bg-white/5"}`} title={folder ? undefined : error ? `${name}\n${error}` : name}>
    <span className="relative flex h-14 w-14 shrink-0 items-center justify-center">
      {folder ? <LuFolder className={`h-14 w-14 fill-amber-100 text-amber-500 ${status === "ignored" ? "opacity-45" : ""}`} strokeWidth={1.3} /> : <LuFile className={`h-12 w-12 text-slate-400 ${status === "ignored" ? "opacity-45" : ""}`} strokeWidth={1.3} />}
      {error && <span role="img" aria-label="오류 있음" title={folder ? undefined : error} className={`${badge} bg-red-600 text-sm font-bold`}>!</span>}
      {!error && status === "searchable" && <span role="img" aria-label="검색 가능" className={`${badge} bg-green-600`}><LuCheck className="h-4 w-4" aria-hidden /></span>}
      {!error && status === "ignored" && <span role="img" aria-label="검색 제외" className={`${badge} bg-zinc-500`}><LuMinus className="h-4 w-4" aria-hidden /></span>}
      {remote && !error && <LuCloud className="absolute -bottom-1 -right-2 h-6 w-6 rounded-full bg-white text-blue-500 dark:bg-[#18181B]" />}
    </span>
    <span className="line-clamp-2 h-10 w-full shrink-0 break-all text-sm font-medium leading-5 text-[#18181B] dark:text-[#FAFAFA]">{name}</span>
    <span className="h-4 shrink-0 whitespace-nowrap text-[11px] leading-4 text-[#71717A]">{detail}</span>
  </button>;
}

export default function FolderPanel({ api, workspaceId, collections, error, onAdd, onRemove, onSync }: Props) {
  const [storages, setStorages] = useState<MaruStorageSummary[]>([]);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [storageLoading, setStorageLoading] = useState(true);
  const [storageVersion, setStorageVersion] = useState(0);
  const [location, setLocation] = useState<Location | null>(null);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [selectedFile, setSelectedFile] = useState<FolderEntry | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const actionId = useRef(0);
  const [disconnecting, setDisconnecting] = useState(false);
  const [selectedFolders, setSelectedFolders] = useState<string[]>([]);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const removalLock = useRef(false);

  const toggleFolder = (name: string) => {
    if (removalLock.current) return;
    setSelectedFolders((current) => current.includes(name) ? current.filter((id) => id !== name) : [...current, name]);
  };
  const disconnectSelected = async () => {
    if (removalLock.current) return;
    const names = selectedFolders.filter((name) => collections.some((item) => item.name === name));
    if (!names.length) return;
    removalLock.current = true;
    setRemoving(true);
    setRemoveError(null);
    const failed: string[] = [];
    try {
      for (const name of names) {
        try { await onRemove(name); } catch { failed.push(name); }
      }
      setSelectedFolders(failed);
      if (failed.length) setRemoveError(`${failed.length}개 폴더를 해제하지 못했습니다. 선택된 항목을 다시 확인해 주세요.`);
      else setDisconnecting(false);
    } finally {
      removalLock.current = false;
      setRemoving(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setStorageLoading(true);
    setStorageError(null);
    api.listMaruStorages(workspaceId).then((items) => { if (!cancelled) setStorages(items); })
      .catch(() => { if (!cancelled) setStorageError("공유 저장소를 불러오지 못했습니다. 연결 상태를 확인해 주세요."); })
      .finally(() => { if (!cancelled) setStorageLoading(false); });
    return () => { cancelled = true; };
  }, [api, workspaceId, storageVersion]);

  useEffect(() => {
    let cancelled = false;
    actionId.current += 1;
    setWorking(false);
    setSelectedFile(null);
    setActionError(null);
    setListing(null);
    setBrowseError(null);
    if (location) api.browseFolder(location).then((result) => { if (!cancelled) setListing(result); })
      .catch(() => { if (!cancelled) setBrowseError("폴더를 열지 못했습니다. 경로와 접근 권한을 확인해 주세요."); });
    return () => { cancelled = true; };
  }, [api, location, version]);

  useEffect(() => {
    if (!location || location.kind !== "local") return;
    let cancelled = false;
    let request = 0;
    const unsubscribe = api.onCollectionsChanged(() => {
      const id = ++request;
      void api.browseFolder(location).then((result) => {
        if (!cancelled && id === request) {
          setListing(result);
          setSelectedFile((file) => file ? result.entries.find((entry) => entry.path === file.path) ?? null : null);
        }
      }).catch(() => undefined);
    });
    return () => { cancelled = true; unsubscribe(); };
  }, [api, location]);

  const runAction = async (action: () => Promise<void>) => {
    const id = ++actionId.current;
    setWorking(true);
    setActionError(null);
    try { await action(); }
    catch { if (id === actionId.current) setActionError("작업을 완료하지 못했습니다. 연결 상태와 접근 권한을 확인해 주세요."); }
    finally { if (id === actionId.current) setWorking(false); }
  };
  const collection = location?.kind === "local" ? collections.find((item) => item.name === location.id) : undefined;
  const parts = location?.path.split("/").filter(Boolean) ?? [];
  const analysisLabel = (item: CollectionSummary) => item.analysisStatus === "pending" ? "분석 대기 중" : item.analysisStatus === "analyzing" || item.syncing ? "분석 중" : "";
  const searchLabel = (entry: FolderEntry) => {
    if (collection?.retryingFile === entry.path) return "분석 중";
    if (entry.searchStatus === "ignored") return "검색 제외";
    if (entryError(entry)) return "오류";
    return entry.searchStatus ? ({ searchable: "검색 가능", pending: "분석 대기 중", analyzing: "분석 중", failed: "오류", ignored: "검색 제외" }[entry.searchStatus]) : undefined;
  };
  const entryError = (entry: FolderEntry) => collection?.failedFiles
    ?.filter((failure) => failure.path === entry.path || (entry.kind === "directory" && failure.path.startsWith(`${entry.path}/`)))
    .map((failure) => `${failure.path}: ${failure.error}`).join("\n") || undefined;

  if (location) return <section className="flex min-h-0 flex-1 flex-col gap-4">
    <div role="region" aria-label="파일 목록" className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain pr-1">
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={button} onClick={() => setLocation(parts.length ? { ...location, path: parts.slice(0, -1).join("/") } : null)} aria-label="상위 폴더"><LuArrowLeft className="h-4 w-4" /></button>
      <nav aria-label="폴더 경로" className="flex flex-1 flex-wrap items-center gap-1 text-sm">
        <button type="button" className={button} onClick={() => setLocation(null)}>문서</button><span>/</span>
        <button type="button" className={button} onClick={() => setLocation({ ...location, path: "" })}>{location.name}</button>
        {parts.map((part, index) => <span key={index} className="flex items-center"><span>/</span><button type="button" className={button} onClick={() => setLocation({ ...location, path: parts.slice(0, index + 1).join("/") })}>{part}</button></span>)}
      </nav>
      <button type="button" className={button} onClick={() => setVersion((value) => value + 1)} aria-label="파일 목록 새로고침"><LuRefreshCw className="h-4 w-4" /></button>
    </div>
    {collection && <div className="flex flex-wrap items-center gap-2 border-b border-[#E4E4E7] pb-3 text-xs dark:border-[#27272A]">
      <span className="min-w-0 flex-1 break-all text-[#71717A]">{collection.path}</span>
      {analysisLabel(collection) && <span role="status" className="text-blue-600 dark:text-blue-400">{analysisLabel(collection)}</span>}
      <button type="button" disabled={working || collection.syncing} className={button} onClick={() => void runAction(() => onSync(collection.name))}>{collection.syncing ? "동기화 중…" : "지금 동기화"}</button>
      <button type="button" disabled={working} className={button} onClick={() => {
        if (window.confirm("폴더 연결을 해제할까요? 원본 폴더와 파일은 삭제되지 않습니다.")) void runAction(async () => { await onRemove(collection.name); setLocation(null); });
      }}>연결 해제</button>
    </div>}
    {browseError ? <p role="alert" className="text-sm text-red-600">{browseError}</p> : !listing ? <p role="status" className="text-sm text-[#71717A]">파일 목록을 불러오는 중…</p> : <>
      {listing.entries.length === 0 && <p className="py-12 text-center text-sm text-[#71717A]">비어 있는 폴더입니다.</p>}
      <div className={grid}>{listing.entries.map((entry) => <Tile key={entry.path} name={entry.name} selected={entry.kind === "file" ? selectedFile?.path === entry.path : undefined} folder={entry.kind === "directory"} error={entryError(entry)} status={collection?.retryingFile === entry.path ? "analyzing" : entry.searchStatus === "ignored" ? "ignored" : entry.kind === "directory" && entry.counts ? entry.counts.searchable === 0 && entry.counts.failed === 0 && !entryError(entry) && !collection?.syncing && collection?.analysisStatus !== "pending" && collection?.analysisStatus !== "analyzing" ? "ignored" : entry.counts.searchable > 0 && entry.counts.failed === 0 ? "searchable" : undefined : entry.searchStatus} detail={entry.counts && entry.searchStatus !== "ignored" ? <FolderCounts {...entry.counts} /> : searchLabel(entry) === "분석 대기 중" || searchLabel(entry) === "분석 중" ? searchLabel(entry) : undefined} onClick={() => {
        if (entry.kind === "directory") setLocation({ ...location, path: entry.path });
        else { setSelectedFile(entry); setActionError(null); }
      }} />)}</div>
      {listing.truncated && <p role="status" className="text-xs text-amber-600">항목이 많아 일부만 표시됩니다. 하위 폴더로 이동해 확인해 주세요.</p>}
    </>}
    </div>
    {selectedFile && <section aria-label="파일 정보" className="max-h-[45%] shrink-0 overflow-y-auto overscroll-contain rounded-xl border border-[#E4E4E7] bg-white p-4 text-sm shadow-sm dark:border-[#27272A] dark:bg-[#18181B]">
      <div className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 break-all font-semibold">{selectedFile.name}</h3>
        <button type="button" className={`${button} shrink-0`} aria-label="파일 정보 닫기" onClick={() => setSelectedFile(null)}><LuX className="h-4 w-4" /></button>
      </div>
      {searchLabel(selectedFile) && <p className="mt-2 text-xs text-[#71717A]">{searchLabel(selectedFile)}</p>}
      {selectedFile.searchStatus === "ignored" && <p className="mt-1 text-xs text-[#71717A]">{selectedFile.statusReason} 원본 파일은 삭제되지 않습니다.</p>}
      {entryError(selectedFile) && <p role="alert" className="mt-2 whitespace-pre-wrap break-all text-xs text-red-600 dark:text-red-400">{entryError(selectedFile)}</p>}
      <p className="mt-2 break-all text-xs text-[#71717A]">{selectedFile.path}</p>
      {selectedFile.size !== undefined && <p className="mt-1 text-xs text-[#71717A]">크기: {selectedFile.size.toLocaleString()} bytes</p>}
      {selectedFile.modifiedAt && <p className="mt-1 text-xs text-[#71717A]">수정: {new Date(selectedFile.modifiedAt).toLocaleString()}</p>}
      {location.kind === "local" && <button type="button" className={`${button} mt-3`} disabled={working} onClick={() => void runAction(() => api.openLocalFolderFile({ ...location, path: selectedFile.path }))}>열기</button>}
      {collection && entryError(selectedFile) && <button type="button" className={`${button} mt-3`} disabled={working || collection.syncing} onClick={() => void runAction(() => api.retryFolderFile({ kind: "local", id: collection.name, path: selectedFile.path }))}>{working || collection.retryingFile === selectedFile.path ? "분석 중…" : "재시도"}</button>}
      <button type="button" className={`${button} mt-3`} disabled={working} onClick={() => void runAction(() => api.revealFolderFile({ ...location, path: selectedFile.path }))}>
        {working ? "준비 중…" : location.kind === "maru" ? "다운로드 후 파일 위치 보기" : "파일 위치 보기"}
      </button>
      <p className="mt-1 text-xs text-[#71717A]">{location.kind === "local" ? "열기를 누르면 기본 앱으로 문서를 엽니다. 재시도는 선택한 실패 파일만 다시 분석합니다. 지원되지 않는 형식은 파일 위치 보기를 이용하세요." : "파일 탐색기에서 원본을 열 수 있습니다."}</p>
    </section>}
    {actionError && <p role="alert" className="max-h-16 shrink-0 overflow-y-auto text-sm text-red-600">{actionError}</p>}
  </section>;

  return <div className="min-h-0 flex-1 space-y-8 overflow-y-auto pr-1">
    <p className="text-sm text-[#71717A]">폴더를 눌러 내부 파일을 확인하세요.</p>
    <section aria-label="내 컴퓨터 폴더">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">내 컴퓨터</h3>
        <div className="flex items-center gap-2">
          {disconnecting ? <>
            <span className="text-xs text-[#71717A]">{selectedFolders.filter((name) => collections.some((item) => item.name === name)).length}개 선택</span>
            <button type="button" className={button} disabled={removing} onClick={() => { setDisconnecting(false); setSelectedFolders([]); setRemoveError(null); }}>취소</button>
            <button type="button" className={`${button} text-red-600 dark:text-red-400`} disabled={removing || !selectedFolders.some((name) => collections.some((item) => item.name === name))} onClick={() => void disconnectSelected()}>{removing ? "해제 중…" : "확인"}</button>
          </> : <>
            <button type="button" className={button} disabled={!collections.length} onClick={() => { setDisconnecting(true); setSelectedFolders([]); setRemoveError(null); }}>연결 해제</button>
            <button type="button" className={`${button} flex items-center gap-2`} onClick={onAdd}><LuFolderPlus className="h-4 w-4" />폴더 연결</button>
          </>}
        </div>
      </div>
      {disconnecting && <p className="mb-3 text-xs text-[#71717A]">연결을 해제할 폴더를 선택한 뒤 확인을 누르세요. 원본 폴더와 파일은 삭제되지 않습니다.</p>}
      {removeError && <p role="alert" className="mb-3 text-xs text-red-600">{removeError}</p>}
      {error && <p role="alert" className="mb-3 text-xs text-red-600">{error}</p>}
      <div className={grid}>{collections.map((item) => <div key={item.name} className={`relative rounded-xl ${disconnecting && selectedFolders.includes(item.name) ? "bg-blue-50 ring-1 ring-blue-400 dark:bg-blue-950/40" : ""}`}>
        {disconnecting && <input type="checkbox" className="absolute left-2 top-2 z-10 h-4 w-4" aria-label={`${item.path} 연결 해제 선택`} checked={selectedFolders.includes(item.name)} disabled={removing} onChange={() => toggleFolder(item.name)} />}
        <Tile status={!analysisLabel(item) && item.sources === 0 && !item.failedFiles?.length && !item.lastError ? "ignored" : undefined} name={item.path.split(/[\\/]/).filter(Boolean).at(-1) ?? item.name} error={[item.lastError, ...(item.failedFiles ?? []).map((failure) => `${failure.path}: ${failure.error}`)].filter(Boolean).join("\n") || undefined} detail={analysisLabel(item) || <FolderCounts searchable={item.sources} failed={item.failedFiles?.length ?? 0} />} onClick={() => {
          if (disconnecting) toggleFolder(item.name);
          else setLocation({ kind: "local", id: item.name, name: item.path.split(/[\\/]/).filter(Boolean).at(-1) ?? item.name, path: "" });
        }} /></div>)}</div>
      {!collections.length && <p className="rounded-xl border border-dashed border-[#D4D4D8] p-8 text-center text-sm text-[#71717A]">내 컴퓨터의 폴더를 연결해 주세요.</p>}
    </section>
    <section aria-label="공유 저장소 MARU" className="border-t border-[#E4E4E7] pt-6 dark:border-[#27272A]">
      <div className="mb-4 flex items-center justify-between"><h3 className="font-semibold">공유 저장소 <span className="ml-1 text-xs font-normal text-[#71717A]">MARU</span></h3><button type="button" className={button} disabled={storageLoading} aria-label="공유 저장소 새로고침" onClick={() => setStorageVersion((value) => value + 1)}><LuRefreshCw className={`h-4 w-4 ${storageLoading ? "animate-spin" : ""}`} /></button></div>
      {storageError ? <p role="alert" className="text-xs text-red-600">{storageError}</p> : storageLoading ? <p role="status" className="text-sm text-[#71717A]">저장소를 불러오는 중…</p> : <>
        <div className={grid}>{storages.map((item) => <Tile key={item.storageId} name={item.name} remote onClick={() => { if (!disconnecting) setLocation({ kind: "maru", id: item.storageId, name: item.name, path: "" }); }} />)}</div>
        {!storages.length && <p className="py-8 text-center text-sm text-[#71717A]">접근 가능한 공유 저장소가 없습니다.</p>}
      </>}
    </section>
  </div>;
}
