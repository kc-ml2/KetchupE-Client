import { useState } from "react";
import { LuMessageCircle, LuPencil, LuTrash2 } from "react-icons/lu";
import type { ThreadSummary } from "@app-types/Agent.types";

type Props = {
  threads: ThreadSummary[];
  activeThreadId: string | null;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
};

/** Sidebar list of local-agent conversations, newest first. */
const ThreadHistory = ({ threads, activeThreadId, onSelect, onRename, onDelete }: Props): React.JSX.Element => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  return (
    <div className="flex flex-col gap-1 py-3 flex-1 min-h-0 w-full">
      <span className="text-[11px] font-medium text-[#71717A] tracking-[0.5px]">대화 내역</span>
      <div className="flex flex-col gap-0.5 overflow-y-auto min-h-0">
        {threads.length === 0 && <span className="px-2 py-1 text-xs text-[#71717A]">아직 대화가 없습니다.</span>}
        {threads.map((thread) => {
          const isActive = thread.id === activeThreadId;
          if (editingId === thread.id) {
            return (
              <form
                key={thread.id}
                className="px-1"
                onSubmit={(event) => {
                  event.preventDefault();
                  onRename(thread.id, draft);
                  setEditingId(null);
                }}
              >
                <input
                  autoFocus
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onBlur={() => setEditingId(null)}
                  className="w-full h-9 px-2 text-sm rounded-md bg-[#27272A] text-[#FAFAFA] border border-[#0066FF] outline-none"
                />
              </form>
            );
          }
          return (
            <div
              key={thread.id}
              className={`group/thread flex items-center gap-1 h-9 px-2 rounded-md w-full transition-colors ${isActive ? "bg-[#0066FF]" : "hover:bg-[#27272A]"}`}
            >
              <button type="button" onClick={() => onSelect(thread.id)} className="flex min-w-0 flex-1 items-center gap-2.5 h-full">
                <LuMessageCircle className={`w-[16px] h-[16px] shrink-0 ${isActive ? "text-white" : "text-[#71717A]"}`} />
                <span className={`min-w-0 flex-1 truncate text-left text-sm ${isActive ? "text-white font-medium" : "text-[#FAFAFA]"}`}>
                  {thread.title || "새 대화"}
                </span>
              </button>
              <button
                type="button"
                aria-label="대화 이름 변경"
                className={`shrink-0 p-1 opacity-0 group-hover/thread:opacity-70 focus:opacity-100 ${isActive ? "text-white" : "text-[#A1A1AA]"}`}
                onClick={() => {
                  setDraft(thread.title);
                  setEditingId(thread.id);
                }}
              >
                <LuPencil className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                aria-label="대화 삭제"
                className={`shrink-0 p-1 opacity-0 group-hover/thread:opacity-70 focus:opacity-100 hover:text-[#FCA5A5] ${isActive ? "text-white" : "text-[#A1A1AA]"}`}
                onClick={() => {
                  if (window.confirm(`“${thread.title || "새 대화"}” 대화를 삭제할까요?`)) onDelete(thread.id);
                }}
              >
                <LuTrash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default ThreadHistory;
