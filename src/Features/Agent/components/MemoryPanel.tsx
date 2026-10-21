import { useState } from "react";
import type { Memory, MemoryInput, MemoryKind } from "@app-types/Agent.types";

type Props = {
  memories: Memory[];
  onAdd: (input: MemoryInput) => Promise<void>;
  onUpdate: (id: string, input: MemoryInput) => Promise<void>;
  onPin: (id: string, pinned: boolean) => Promise<void>;
  onConfirm: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
};

const KIND_LABEL: Record<MemoryKind, string> = {
  preference: "응답 방식",
  fact: "업무 정보",
  task: "작업(기존)",
};
const field = "w-full rounded-lg border border-[#E4E4E7] bg-white px-2.5 py-2 text-sm text-[#18181B] outline-none focus:border-[#0066FF] dark:border-[#27272A] dark:bg-[#0F0F0F] dark:text-[#FAFAFA]";

const MemoryPanel = ({ memories, onAdd, onUpdate, onPin, onConfirm, onDelete }: Props): React.JSX.Element => {
  const [kind, setKind] = useState<MemoryKind>("preference");
  const [content, setContent] = useState("");
  const [pinned, setPinned] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [error, setError] = useState<string | null>(null);

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!content.trim()) return;
    try {
      setError(null);
      await onAdd({ kind, content, pinned });
      setContent("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const update = async (memory: Memory) => {
    if (!editContent.trim()) return;
    try {
      setError(null);
      await onUpdate(memory.id, { kind: memory.kind, content: editContent, pinned: memory.pinned });
      setEditingId(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const perform = async (action: () => Promise<void>) => {
    try {
      setError(null);
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <form onSubmit={add} className="flex flex-col gap-2 rounded-lg border border-dashed border-[#A1A1AA] p-3 dark:border-[#3F3F46]">
        <select
          value={kind}
          onChange={(event) => {
            const next = event.target.value as MemoryKind;
            setKind(next);
            setPinned(next === "preference");
          }}
          className={field}
          aria-label="컨텍스트 종류"
        >
          <option value="preference">응답 방식</option>
          <option value="fact">업무 정보</option>
        </select>
        <textarea
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder={kind === "preference" ? "예: 답변은 결론부터 존댓말로 작성" : "예: 우리 회사 회계연도는 4월에 시작"}
          maxLength={500}
          rows={2}
          className={`${field} resize-none`}
          aria-label="새 컨텍스트 내용"
        />
        <label className="flex items-center gap-2 text-xs text-[#52525B] dark:text-[#A1A1AA]">
          <input type="checkbox" checked={pinned} onChange={(event) => setPinned(event.target.checked)} />
          모든 질문에 항상 적용
        </label>
        <button type="submit" disabled={!content.trim()} className="self-start rounded-lg bg-[#0066FF] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40">
          컨텍스트 추가
        </button>
      </form>

      <p className="text-[11px] leading-relaxed text-[#71717A]">
        직접 저장한 컨텍스트는 바로 사용할 수 있습니다. 문서 내용은 여기에 복사하지 말고 참고 문서에 두세요.
      </p>
      {error && <p className="text-xs text-[#DC2626]">{error}</p>}
      {memories.length === 0 && <p className="text-xs text-[#71717A]">저장된 컨텍스트가 없습니다.</p>}

      {memories.map((memory) => (
        <div key={memory.id} className="rounded-lg border border-[#E4E4E7] p-3 text-sm dark:border-[#27272A]">
          <div className="flex items-center gap-2 text-[11px] text-[#71717A]">
            <span>{KIND_LABEL[memory.kind]}</span>
            <span className={memory.status === "pending" ? "text-[#D97706]" : "text-[#16A34A]"}>
              {memory.status === "pending" ? "확인 대기" : memory.pinned ? "항상 적용" : "관련 질문에 적용"}
            </span>
          </div>

          {editingId === memory.id ? (
            <div className="mt-2 flex flex-col gap-2">
              <textarea value={editContent} onChange={(event) => setEditContent(event.target.value)} maxLength={500} rows={2} className={`${field} resize-none`} aria-label="컨텍스트 내용 수정" />
              <div className="flex gap-3 text-xs">
                <button type="button" onClick={() => void update(memory)} className="text-[#0066FF] hover:underline">저장</button>
                <button type="button" onClick={() => setEditingId(null)} className="text-[#71717A] hover:underline">취소</button>
              </div>
            </div>
          ) : (
            <p className="mt-1 text-[#18181B] dark:text-[#FAFAFA]">{memory.content}</p>
          )}

          {editingId !== memory.id && (
            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
              {memory.status === "pending" && <button type="button" onClick={() => void perform(() => onConfirm(memory.id))} className="text-[#0066FF] hover:underline">저장하기</button>}
              {memory.status === "confirmed" && (
                <label className="flex items-center gap-1.5 text-[#71717A]">
                  <input type="checkbox" checked={memory.pinned} onChange={(event) => void perform(() => onPin(memory.id, event.target.checked))} />
                  항상 적용
                </label>
              )}
              <button type="button" onClick={() => { setEditingId(memory.id); setEditContent(memory.content); }} className="text-[#0066FF] hover:underline">수정</button>
              <button type="button" onClick={() => window.confirm("이 컨텍스트를 삭제할까요?") && void perform(() => onDelete(memory.id))} className="text-[#DC2626] hover:underline">삭제</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

export default MemoryPanel;
