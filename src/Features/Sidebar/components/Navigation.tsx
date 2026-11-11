import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import type { AppTab } from "@app-types/Navigation.types";
import NavRail from "./NavRail";
import Sidebar from "./Sidebar";

/** Only Home currently owns a secondary panel. Hover never changes the main view. */
const Navigation = ({ tab, onChange }: {
  tab: AppTab;
  onChange: (tab: AppTab) => void;
}): React.JSX.Element => {
  const [open, setOpen] = useState(false);
  const [held, setHeld] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const location = useLocation();

  const clearTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const close = () => {
    clearTimer();
    setOpen(false);
    setHeld(false);
  };

  useEffect(() => {
    clearTimer();
    setOpen(false);
    setHeld(false);
  }, [location.key]);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", outside);
    return () => {
      clearTimer();
      document.removeEventListener("pointerdown", outside);
    };
  }, []);

  return (
    <div
      ref={root}
      className="relative z-30 flex shrink-0"
      onMouseLeave={() => {
        clearTimer();
        if (!held) timer.current = setTimeout(() => setOpen(false), 200);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          close();
          root.current?.querySelector<HTMLButtonElement>('[aria-controls="home-history-panel"]')?.focus();
          clearTimer();
        }
      }}
    >
      <NavRail
        tab={tab}
        homeExpanded={open}
        onPreview={(next) => {
          clearTimer();
          if (next !== "home") {
            close();
          } else {
            timer.current = setTimeout(() => setOpen(true), 200);
          }
        }}
        onChange={(next) => {
          clearTimer();
          onChange(next);
          if (next === "home") {
            setOpen(true);
            setHeld(true);
          } else close();
        }}
      />
      {open && (
        <aside
          id="home-history-panel"
          aria-label="홈 대화 히스토리"
          className="absolute left-full inset-y-0 overflow-hidden rounded-r-xl shadow-2xl border-y border-r border-[#27272A]"
          onMouseEnter={clearTimer}
        >
          <button
            type="button"
            aria-label="대화 히스토리 닫기"
            onClick={close}
            className="absolute right-4 top-5 z-10 rounded px-2 py-1 text-[#A1A1AA] hover:bg-[#27272A] hover:text-white"
          >
            ×
          </button>
          <Sidebar />
        </aside>
      )}
    </div>
  );
};

export default Navigation;
