import { useContext, useEffect, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { isMobile as isMobileDevice } from "react-device-detect";
import { LuPlus, LuSun, LuMoon, LuFolderSearch } from "react-icons/lu";
import { ThemeContext, ThemeContextType } from "@Contexts/ThemeContext";
import { ThreadsContext, ThreadsContextType } from "@Contexts/ThreadsContext";
import ThreadHistory from "./ThreadHistory";

const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 420;
const SIDEBAR_DEFAULT_WIDTH = 260;
const SIDEBAR_WIDTH_STORAGE_KEY = "ketchupe.sidebar.width";

const clampSidebarWidth = (width: number): number => {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
};

const Sidebar = (): React.JSX.Element => {
  const { threads, createThread, renameThread, deleteThread } = useContext(ThreadsContext) as ThreadsContextType;
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    if (typeof window === "undefined") return SIDEBAR_DEFAULT_WIDTH;
    const saved = Number(
      window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY),
    );
    return Number.isFinite(saved)
      ? clampSidebarWidth(saved)
      : SIDEBAR_DEFAULT_WIDTH;
  });
  const resizeStateRef = useRef<{
    startX: number;
    startWidth: number;
    previousCursor: string;
    previousUserSelect: string;
  } | null>(null);
  const { theme, setTheme } = useContext(ThemeContext) as ThemeContextType;
  const navigate = useNavigate();
  const location = useLocation();

  const isAgentActive = location.pathname === "/agent";
  const activeThreadId = location.pathname.startsWith("/agent/")
    ? decodeURIComponent(location.pathname.slice("/agent/".length))
    : null;

  const handleCreateThread = async () => {
    const thread = await createThread();
    if (thread) navigate(`/agent/${thread.id}`);
  };

  const handleDeleteThread = async (id: string) => {
    try {
      await deleteThread(id);
      if (id === activeThreadId) navigate("/agent");
    } catch (cause) {
      window.alert(cause instanceof Error ? cause.message : String(cause));
    }
  };

  useEffect(() => {
    window.localStorage.setItem(
      SIDEBAR_WIDTH_STORAGE_KEY,
      String(sidebarWidth),
    );
  }, [sidebarWidth]);

  useEffect(() => {
    if (isMobileDevice) return;

    const handlePointerMove = (event: PointerEvent) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState) return;

      const deltaX = event.clientX - resizeState.startX;
      setSidebarWidth(clampSidebarWidth(resizeState.startWidth + deltaX));
    };

    const stopResize = () => {
      const resizeState = resizeStateRef.current;
      if (!resizeState) return;

      document.body.style.cursor = resizeState.previousCursor;
      document.body.style.userSelect = resizeState.previousUserSelect;
      resizeStateRef.current = null;
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
      stopResize();
    };
  }, []);

  const handleResizeStart = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;

    event.preventDefault();
    resizeStateRef.current = {
      startX: event.clientX,
      startWidth: sidebarWidth,
      previousCursor: document.body.style.cursor,
      previousUserSelect: document.body.style.userSelect,
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <>
      {!isMobileDevice && (
        <div
          className="flex relative flex-col h-full bg-[#18181B] px-3 py-4 flex-shrink-0"
          style={{ width: `${sidebarWidth}px` }}
        >
          {/* App Header */}
          <div className="flex items-center gap-2.5 h-11 px-1">
            <LuFolderSearch className="w-[22px] h-[22px] text-[#0066FF]" />
            <span className="text-lg font-semibold text-[#FAFAFA]">케찹이</span>
          </div>

          {/* Divider */}
          <div className="h-px w-full bg-[#27272A]" />

          {/* Chat Channel */}
          <div className="flex flex-col gap-1 py-3 w-full">
            {/* <span className="text-[11px] font-medium text-[#71717A] tracking-[0.5px]">
            채널
          </span> */}
            <button
              onClick={() => navigate("/agent")}
              className={`flex items-center gap-2.5 h-9 px-2 rounded-md w-full transition-colors ${
                isAgentActive ? "bg-[#0066FF]" : "hover:bg-[#27272A]"
              }`}
            >
              <LuFolderSearch
                className={`w-[18px] h-[18px] ${isAgentActive ? "text-white" : "text-[#71717A]"}`}
              />
              <span
                className={`text-sm font-medium ${isAgentActive ? "text-white" : "text-[#FAFAFA]"}`}
              >
                새 질문
              </span>
            </button>
          </div>

          {/* Divider */}
          <div className="h-px w-full bg-[#27272A]" />

          {/* Conversation history (local agent threads) */}
          <ThreadHistory
            threads={threads}
            activeThreadId={activeThreadId}
            onSelect={(id) => navigate(`/agent/${id}`)}
            onRename={(id, title) => void renameThread(id, title)}
            onDelete={(id) => void handleDeleteThread(id)}
          />

          {/* Divider */}
          <div className="h-px w-full bg-[#27272A]" />

          {/* New conversation */}
          <button
            onClick={() => void handleCreateThread()}
            className="flex items-center justify-center gap-2 h-10 rounded-lg border border-[#ffffff] w-full cursor-pointer text-[#ffffff] hover:border-[#0066FF] hover:bg-[#0066FF] transition-colors"
          >
            <LuPlus className="w-[18px] h-[18px]" />
            <span className="text-sm font-medium">새 대화</span>
          </button>

          {/* Divider */}
          <div className="h-px w-full bg-[#27272A] mt-3" />

          {/* Theme */}
          <div className="flex items-center gap-1 h-9 p-1 mt-3 rounded-lg bg-[#27272A] w-full">
            <button
              type="button"
              onClick={() => setTheme("light")}
              className={`flex items-center justify-center flex-1 h-full rounded-md cursor-pointer transition-colors ${
                theme === "light" ? "bg-[#3F3F46]" : "hover:bg-[#3F3F46]"
              }`}
              aria-label="라이트 테마"
            >
              <LuSun className={`w-3.5 h-3.5 ${theme === "light" ? "text-[#FAFAFA]" : "text-[#71717A]"}`} />
            </button>
            <button
              type="button"
              onClick={() => setTheme("dark")}
              className={`flex items-center justify-center flex-1 h-full rounded-md cursor-pointer transition-colors ${
                theme === "dark" ? "bg-[#3F3F46]" : "hover:bg-[#3F3F46]"
              }`}
              aria-label="다크 테마"
            >
              <LuMoon className={`w-3.5 h-3.5 ${theme === "dark" ? "text-[#FAFAFA]" : "text-[#71717A]"}`} />
            </button>
          </div>

          <button
            type="button"
            onPointerDown={handleResizeStart}
            aria-label="사이드바 너비 조절"
            className="absolute top-0 right-0 h-full w-2 cursor-col-resize bg-transparent hover:bg-[#3F3F46]/50 active:bg-[#3F3F46]/70 transition-colors"
            style={{ touchAction: "none" }}
          />
        </div>
      )}


    </>
  );
};

export default Sidebar;
