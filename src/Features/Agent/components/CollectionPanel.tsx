import { LuFolderPlus, LuRefreshCw, LuTrash2 } from "react-icons/lu";
import type { CollectionSummary } from "@app-types/Agent.types";

type Props = {
  collections: CollectionSummary[];
  error: string | null;
  onAdd: () => void;
  onRemove: (name: string) => void;
  onSync: (name: string) => void;
  onToggle: (name: string, active: boolean) => void;
};

const CollectionPanel = ({
  collections,
  error,
  onAdd,
  onRemove,
  onSync,
  onToggle,
}: Props): React.JSX.Element => (
  <div className="flex flex-col gap-3">
    <button
      type="button"
      onClick={onAdd}
      className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold border border-dashed border-[#0066FF] text-[#0066FF] hover:bg-[#E6F0FF]"
    >
      <LuFolderPlus className="w-4 h-4" />
      폴더 등록
    </button>
    <p className="text-[11px] text-[#71717A]">
      폴더를 등록하면 변경 사항이 자동으로 반영됩니다.
    </p>
    {error && <p className="text-xs text-[#DC2626]">{error}</p>}
    {collections.map((collection) => (
      <div
        key={collection.name}
        className="p-3 rounded-lg border border-[#E4E4E7] dark:border-[#27272A] text-sm"
      >
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={collection.active}
            onChange={(event) =>
              onToggle(collection.name, event.target.checked)
            }
            title="검색 범위에 포함"
          />
          <span
            className="flex-1 font-semibold truncate text-[#18181B] dark:text-[#FAFAFA]"
            title={collection.path}
          >
            {collection.name}
          </span>
          <button
            type="button"
            title="지금 동기화"
            onClick={() => onSync(collection.name)}
            className="text-[#71717A] hover:text-[#0066FF]"
          >
            <LuRefreshCw
              className={`w-3.5 h-3.5 ${collection.syncing ? "animate-spin" : ""}`}
            />
          </button>
          <button
            type="button"
            title="등록 해제"
            onClick={() => onRemove(collection.name)}
            className="text-[#71717A] hover:text-[#DC2626]"
          >
            <LuTrash2 className="w-3.5 h-3.5" />
          </button>
        </div>
        <p className="mt-1 text-[11px] text-[#71717A] truncate">
          {collection.path}
        </p>
        <p className="mt-1 text-[11px] text-[#71717A]">
          문서 {collection.sources} · chunk {collection.chunks} · embedding{" "}
          {collection.embedded}/{collection.chunks}
          {collection.embedded < collection.chunks
            ? " (keyword 검색으로 동작 중)"
            : " (hybrid 검색)"}
        </p>
        {collection.lastError && (
          <p className="mt-1 text-[11px] text-[#DC2626]">
            {collection.lastError}
          </p>
        )}
      </div>
    ))}
  </div>
);

export default CollectionPanel;
