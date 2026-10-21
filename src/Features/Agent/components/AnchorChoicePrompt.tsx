import { LuCheck } from "react-icons/lu";
import ragIcon from "@images/rag.png";
import { AnchorCandidate, AnchorChoiceAction } from "@app-types/CanvasEdit.types";

interface AnchorChoicePromptProps {
  candidates: AnchorCandidate[];
  selectedIds: string[];
  disabled: boolean;
  onToggle: (documentId: string) => void;
  onSubmit: (action: AnchorChoiceAction) => void;
}

// awaiting_anchor_choice interrupt: 참고 문서 후보를 다중 선택하고 resume으로 응답하는 UI
const AnchorChoicePrompt = ({
  candidates,
  selectedIds,
  disabled,
  onToggle,
  onSubmit,
}: AnchorChoicePromptProps) => {
  const hasSelection = selectedIds.length > 0;

  return (
    <div className="flex flex-col mb-2 items-start">
      <div className="flex items-start flex-row">
        <img src={ragIcon} alt="Assistant" className="w-7 h-7 object-cover" />
        <div className="px-4 py-3 rounded-2xl leading-tight text-gray-900 dark:text-[#FAFAFA] rounded-br-md mr-12 max-w-[85%] border border-[#E4E4E7] dark:border-[#27272A]">
          <p className="text-sm mb-3">
            참고할 계약서를 선택해 주세요. (여러 개 선택 가능)
          </p>

          {/* 후보 문서 목록 (다중 선택 토글) */}
          <div className="flex flex-col gap-1.5 mb-3">
            {candidates.map((candidate) => {
              const isSelected = selectedIds.includes(candidate.document_id);
              return (
                <button
                  key={candidate.document_id}
                  type="button"
                  disabled={disabled}
                  onClick={() => onToggle(candidate.document_id)}
                  title={candidate.document_id}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-left transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
                    isSelected
                      ? "border border-[#0066FF] bg-[#0066FF]/5 text-[#0066FF] font-medium"
                      : "border border-[#D4D4D8] dark:border-[#3F3F46] text-[#18181B] dark:text-[#FAFAFA] hover:border-[#0066FF]"
                  }`}
                >
                  <span
                    className={`flex items-center justify-center w-4 h-4 flex-shrink-0 rounded border ${
                      isSelected
                        ? "border-[#0066FF] bg-[#0066FF]"
                        : "border-[#A1A1AA]"
                    }`}
                  >
                    {isSelected && <LuCheck className="w-3 h-3 text-white" />}
                  </span>
                  <span className="break-all">{candidate.name}</span>
                </button>
              );
            })}
          </div>

          {/* 응답 옵션 */}
          <div className="flex flex-wrap gap-2">
            {hasSelection && (
              <button
                type="button"
                disabled={disabled}
                onClick={() => onSubmit("use_selected")}
                className="px-3 py-1.5 rounded-lg text-sm font-medium bg-[#0066FF] text-white hover:bg-[#0052CC] transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                선택한 문서 참고하기
              </button>
            )}
            <button
              type="button"
              disabled={disabled}
              onClick={() => onSubmit("skip")}
              className="px-3 py-1.5 rounded-lg text-sm font-medium border border-[#D4D4D8] text-[#71717A] dark:text-[#A1A1AA] hover:border-[#A1A1AA] hover:text-[#18181B] dark:hover:text-[#FAFAFA] transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              여기서 문서 참고 안하기
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AnchorChoicePrompt;
