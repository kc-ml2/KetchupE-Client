import { useContext, useState } from "react";
import { LuLogOut, LuSun, LuMoon, LuUserRound } from "react-icons/lu";
import { AccountContext } from "@Contexts/AccountContext";
import { ThemeContext } from "@Contexts/ThemeContext";

const RailAccount = (): React.JSX.Element => {
  const account = useContext(AccountContext);
  const theme = useContext(ThemeContext);
  const [loggingOut, setLoggingOut] = useState(false);
  const logout = async () => {
    if (!account || loggingOut) return;
    setLoggingOut(true);
    try {
      await account.logout();
    } catch {
      window.alert("로그아웃하지 못했습니다. 다시 시도해 주세요.");
    } finally {
      setLoggingOut(false);
    }
  };
  const buttonClass = "flex h-11 w-12 items-center justify-center rounded-lg text-[#A1A1AA] hover:bg-[#27272A] hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#0066FF] disabled:opacity-40";

  return (
    <div aria-label="계정 및 테마" className="mt-auto flex flex-col items-center gap-1 border-t border-[#27272A] pt-3">
      {account && (
        <>
          <div tabIndex={0} aria-label={`로그인 계정: ${account.email}`} title={account.email} className="group relative flex h-11 w-12 items-center justify-center rounded-lg text-[#A1A1AA] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#0066FF]">
            <LuUserRound className="h-5 w-5" aria-hidden />
            <span className="pointer-events-none absolute left-full bottom-0 z-50 ml-2 hidden w-max max-w-[70vw] whitespace-nowrap overflow-hidden text-ellipsis rounded-lg border border-[#3F3F46] bg-[#18181B] px-3 py-2 text-xs text-white shadow-lg group-hover:block group-focus:block">
              {account.email}
            </span>
          </div>
          <button type="button" aria-label="로그아웃" title="로그아웃" disabled={loggingOut} onClick={() => void logout()} className={buttonClass}>
            <LuLogOut className="h-5 w-5" aria-hidden />
          </button>
        </>
      )}
      {theme && (
        <button type="button" aria-label={theme.theme === "dark" ? "라이트 테마로 전환" : "다크 테마로 전환"} title={theme.theme === "dark" ? "라이트 테마로 전환" : "다크 테마로 전환"} onClick={theme.toggleTheme} className={buttonClass}>
          {theme.theme === "dark" ? <LuSun className="h-5 w-5" aria-hidden /> : <LuMoon className="h-5 w-5" aria-hidden />}
        </button>
      )}
    </div>
  );
};

export default RailAccount;
