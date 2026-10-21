import { LuChevronRight } from "react-icons/lu";
import type { WorkflowShortcut } from "@app-types/Navigation.types";

// ponytail: mirrors the workflow IDs registered in electron/agent/runtime.ts; add a listWorkflows IPC if the set starts changing often.
const WORKFLOW_SHORTCUTS: readonly WorkflowShortcut[] = [
  {
    mode: "daily_cash",
    label: "일일자금일보 작성하기",
    description: "원천 엑셀을 지정해 일일자금일보를 만듭니다.",
  },
  {
    mode: "doc",
    label: "계약서 초안 작성하기",
    description: "등록된 문서를 근거로 계약서·공문 등의 초안을 씁니다.",
  },
];

const WorkflowLauncher = ({
  disabled,
  onStart,
}: {
  disabled: boolean;
  onStart: (workflow: WorkflowShortcut) => void;
}): React.JSX.Element => (
  <div className="grid gap-3 sm:grid-cols-2">
    {WORKFLOW_SHORTCUTS.map((workflow) => (
      <button
        key={workflow.mode}
        type="button"
        disabled={disabled}
        onClick={() => onStart(workflow)}
        className="flex items-center gap-3 rounded-xl border border-[#E4E4E7] dark:border-[#27272A] p-4 text-left transition-colors hover:border-[#0066FF] hover:bg-[#EFF6FF] dark:hover:bg-[#0B1B33] disabled:opacity-40 disabled:pointer-events-none"
      >
        <span className="flex-1">
          <span className="block text-sm font-semibold text-[#18181B] dark:text-[#FAFAFA]">
            {workflow.label}
          </span>
          <span className="mt-1 block text-xs text-[#71717A]">
            {workflow.description}
          </span>
        </span>
        <LuChevronRight className="w-4 h-4 text-[#71717A]" aria-hidden />
      </button>
    ))}
  </div>
);

export default WorkflowLauncher;
