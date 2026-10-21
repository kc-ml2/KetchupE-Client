import { LuBriefcase, LuHouse, LuLayers, LuSettings, LuUpload } from "react-icons/lu";
import type { AppTab } from "@app-types/Navigation.types";

const TABS = [
  ["home", LuHouse, "홈"],
  ["settings", LuSettings, "설정"],
  ["work", LuBriefcase, "업무"],
  ["upload", LuUpload, "파일"],
  ["context", LuLayers, "컨텍스트"],
] as const;

const NavRail = ({
  tab,
  onChange,
}: {
  tab: AppTab;
  onChange: (tab: AppTab) => void;
}): React.JSX.Element => (
  <nav
    role="tablist"
    aria-label="화면 전환"
    aria-orientation="vertical"
    className="flex flex-col items-center gap-1 w-[68px] shrink-0 py-4 bg-[#09090B] border-r border-[#27272A]"
  >
    {TABS.map(([key, Icon, label]) => (
      <button
        key={key}
        type="button"
        role="tab"
        aria-selected={tab === key}
        onClick={() => onChange(key)}
        className={`flex flex-col items-center justify-center gap-1 w-14 h-14 rounded-lg text-[11px] font-medium transition-colors ${
          tab === key
            ? "bg-[#0066FF] text-white"
            : "text-[#A1A1AA] hover:bg-[#27272A] hover:text-[#FAFAFA]"
        }`}
      >
        <Icon className="w-5 h-5" aria-hidden />
        {label}
      </button>
    ))}
  </nav>
);

export default NavRail;
