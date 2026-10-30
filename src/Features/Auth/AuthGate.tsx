import { useEffect, useMemo, useState, type PropsWithChildren } from "react";
import { useNavigate } from "react-router-dom";
import {
  LuArrowLeft,
  LuArrowRight,
  LuCheck,
  LuCircleAlert,
  LuClock3,
  LuFolderSearch,
  LuLoaderCircle,
  LuMail,
  LuShieldCheck,
} from "react-icons/lu";
import type { AuthState } from "@app-types/Auth.types";
import { AgentApiContext } from "@Contexts/AgentApiContext";
import { AccountContext } from "@Contexts/AccountContext";

export default function AuthGate({ children }: PropsWithChildren) {
  const auth = window.authAPI;
  const navigate = useNavigate();
  const [state, setState] = useState<AuthState | null>(null);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const api = useMemo(
    () => (state?.sessionId ? auth?.agent(state.sessionId) : null),
    [auth, state?.sessionId],
  );
  const account = useMemo(
    () =>
      auth && state?.email
        ? { email: state.email, logout: () => auth.logout() }
        : null,
    [auth, state?.email],
  );

  useEffect(() => {
    if (!auth) return;
    let live = true;
    let changed = false;
    const unsubscribe = auth.onChange((next) => {
      changed = true;
      if (!live) return;
      setState(next);
      setError("");
      if (next.phase !== "code") setCode("");
      if (next.phase === "ready" || next.phase === "signed_out")
        navigate("/agent", { replace: true });
    });
    void auth
      .getState()
      .then((next) => {
        if (live && !changed) setState(next);
      })
      .catch(() => {
        if (live)
          setError(
            "로그인 상태를 확인하지 못했습니다. 앱을 다시 실행해 주세요.",
          );
      });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [auth, navigate]);

  useEffect(() => {
    if (state?.email) setEmail(state.email);
  }, [state?.email]);

  useEffect(() => {
    if (!state?.expiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state?.expiresAt]);

  const act = (action: () => Promise<void>) => {
    setError("");
    void action().catch(() =>
      setError("요청을 처리하지 못했습니다. 다시 시도해 주세요."),
    );
  };

  if (!auth)
    return (
      <main className="grid h-screen place-items-center p-8">
        케찹이 데스크톱 앱에서 사내 이메일로 로그인해 주세요.
      </main>
    );
  if (state?.phase === "ready" && api)
    return (
      <AgentApiContext.Provider key={state.sessionId} value={api}>
        <AccountContext.Provider value={account}>
          <div className="h-screen">{children}</div>
        </AccountContext.Provider>
      </AgentApiContext.Provider>
    );

  const phase = state?.phase;
  const enteringCode = phase === "code" || phase === "verifying";
  const requesting = phase === "requesting";
  const remaining = Math.max(
    0,
    Math.ceil((Date.parse(state?.expiresAt ?? "") - now) / 1000),
  );
  const preparing =
    phase === "provisioning" ||
    phase === "paused" ||
    phase === "action_required" ||
    phase === "activating";
  const step = preparing ? 2 : enteringCode ? 1 : 0;
  const field =
    "w-full rounded-xl border border-[#E4E4E7] bg-[#F4F4F5] px-4 py-3.5 text-[#18181B] placeholder:text-[#71717A] focus:border-[#0066FF] focus:outline-none focus:ring-2 focus:ring-[#0066FF]/20 disabled:cursor-wait disabled:opacity-50 dark:border-[#27272A] dark:bg-[#18181B] dark:text-[#FAFAFA] dark:placeholder:text-[#A1A1AA] dark:focus:border-[#0066FF]";
  const button =
    "flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#18181B] px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-[#3F3F46] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#0066FF] disabled:cursor-not-allowed disabled:opacity-50 dark:bg-[#FAFAFA] dark:text-[#18181B] dark:hover:bg-[#D4D4D8]";
  const secondaryButton =
    "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-2 text-sm text-[#52525B] transition-colors hover:bg-[#F4F4F5] hover:text-[#18181B] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0066FF] disabled:opacity-50 dark:text-[#A1A1AA] dark:hover:bg-[#27272A] dark:hover:text-[#FAFAFA]";
  return (
    <main className="flex min-h-screen flex-col bg-white text-[#18181B] dark:bg-[#0F0F0F] dark:text-[#FAFAFA]">
      <header className="flex h-[72px] shrink-0 items-center gap-2.5 px-6 sm:px-8">
        <LuFolderSearch
          className="h-[22px] w-[22px] text-[#0066FF]"
          aria-hidden
        />
        <span className="text-lg font-semibold">케찹이</span>
      </header>
      <div className="flex flex-1 items-center justify-center px-6 py-12 sm:py-16">
        <section className="w-full max-w-sm" aria-labelledby="login-title">
          <div className="mb-8 flex h-14 w-14 items-center justify-center rounded-2xl border border-[#E4E4E7] bg-[#F4F4F5] dark:border-[#27272A] dark:bg-[#18181B]">
            {preparing ? (
              <LuShieldCheck className="h-6 w-6" aria-hidden />
            ) : (
              <LuFolderSearch className="h-6 w-6" aria-hidden />
            )}
          </div>
          <h1
            id="login-title"
            className="text-3xl font-semibold tracking-tight"
          >
            {enteringCode
              ? "메일함을 확인해 주세요"
              : preparing
                ? "거의 다 왔어요"
                : phase === "signing_out"
                  ? "안전하게 마무리하고 있어요"
                  : "업무의 시작, 케찹이와 함께"}
          </h1>
          <p className="mt-3 text-sm leading-6 text-[#52525B] dark:text-[#A1A1AA]">
            {enteringCode
              ? "이메일로 받은 6자리 인증코드를 입력해 주세요."
              : preparing
                ? "인증을 마치고 나만의 작업 공간을 준비합니다."
                : phase === "signing_out"
                  ? "잠시만 기다려 주세요."
                  : "사내 이메일로 시작하세요."}
          </p>
          {state && phase !== "signing_out" && (
            <ol
              aria-label="로그인 진행 단계"
              className="mb-8 mt-8 flex items-center text-xs"
            >
              {["이메일", "코드 확인", "작업 공간"].map((label, index) => (
                <li
                  key={label}
                  aria-current={step === index ? "step" : undefined}
                  className={`flex items-center gap-2 ${index < 2 ? "flex-1" : ""} ${step === index ? "font-medium text-[#18181B] dark:text-[#FAFAFA]" : "text-[#71717A] dark:text-[#A1A1AA]"}`}
                >
                  <span
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${index <= step ? "bg-[#18181B] text-white dark:bg-[#FAFAFA] dark:text-[#18181B]" : "border border-[#E4E4E7] dark:border-[#3F3F46]"}`}
                  >
                    {index < step ? (
                      <>
                        <LuCheck className="h-3.5 w-3.5" aria-hidden />
                        <span className="sr-only">완료</span>
                      </>
                    ) : (
                      index + 1
                    )}
                  </span>
                  <span className="whitespace-nowrap">{label}</span>
                  {index < 2 && (
                    <span
                      className="mx-2 h-px min-w-2 flex-1 bg-[#E4E4E7] dark:bg-[#27272A]"
                      aria-hidden
                    />
                  )}
                </li>
              ))}
            </ol>
          )}
          {!state && (
            <p
              className="mt-8 flex items-center gap-2 text-sm text-[#52525B] dark:text-[#A1A1AA]"
              role="status"
            >
              <LuLoaderCircle
                className="h-4 w-4 motion-safe:animate-spin"
                aria-hidden
              />
              로그인 상태를 확인하고 있습니다.
            </p>
          )}
          {(phase === "signed_out" || requesting) && (
            <form
              className="space-y-4"
              aria-busy={requesting}
              onSubmit={(event) => {
                event.preventDefault();
                act(() => auth.requestCode(email));
              }}
            >
              <label className="block space-y-2.5">
                <span className="text-sm font-medium">사내 이메일</span>
                <span className="relative block">
                  <LuMail
                    className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#71717A] dark:text-[#A1A1AA]"
                    aria-hidden
                  />
                  <input
                    className={`${field} pl-11 text-sm`}
                    type="email"
                    autoComplete="email"
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder="name@company.com"
                    autoFocus
                    required
                    maxLength={254}
                    value={email}
                    disabled={requesting}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </span>
              </label>
              <button className={button} disabled={requesting}>
                {requesting ? (
                  <LuLoaderCircle
                    className="h-4 w-4 motion-safe:animate-spin"
                    aria-hidden
                  />
                ) : null}
                {requesting ? "인증코드 요청 중…" : "인증코드 받기"}
                {!requesting && (
                  <LuArrowRight className="h-4 w-4" aria-hidden />
                )}
              </button>
              <p className="text-center text-xs leading-5 text-[#71717A] dark:text-[#A1A1AA]">
                비밀번호 없이 이메일 인증으로 로그인합니다.
              </p>
            </form>
          )}
          {enteringCode && state && (
            <form
              className="space-y-4"
              aria-busy={phase === "verifying"}
              onSubmit={(event) => {
                event.preventDefault();
                act(() => auth.verifyCode(code));
              }}
            >
              <p className="flex items-center gap-2 text-sm text-[#52525B] dark:text-[#A1A1AA]">
                <LuMail className="h-4 w-4 shrink-0" aria-hidden />
                <span className="break-all">{state.email}</span>
              </p>
              <label className="block space-y-2.5">
                <span className="text-sm font-medium">6자리 인증코드</span>
                <input
                  className={`${field} text-center font-mono text-2xl tracking-[0.35em]`}
                  aria-describedby="code-expiry"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="000000"
                  autoFocus
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                  value={code}
                  disabled={phase === "verifying"}
                  onChange={(event) =>
                    setCode(event.target.value.replace(/\D/g, ""))
                  }
                />
              </label>
              <p
                id="code-expiry"
                className="flex items-center gap-1.5 text-xs text-[#52525B] dark:text-[#A1A1AA]"
              >
                <LuClock3 className="h-3.5 w-3.5 shrink-0" aria-hidden />
                {remaining
                  ? `남은 시간 ${Math.floor(remaining / 60)}분 ${remaining % 60}초`
                  : "코드가 만료되었습니다. 다시 요청해 주세요."}
              </p>
              <button
                className={button}
                disabled={phase === "verifying" || !remaining}
              >
                {phase === "verifying" && (
                  <LuLoaderCircle
                    className="h-4 w-4 motion-safe:animate-spin"
                    aria-hidden
                  />
                )}
                {phase === "verifying" ? "확인 중…" : "인증하기"}
                {phase !== "verifying" && (
                  <LuArrowRight className="h-4 w-4" aria-hidden />
                )}
              </button>
              <div className="text-center">
                <button
                  type="button"
                  className={secondaryButton}
                  disabled={phase === "verifying"}
                  onClick={() => act(() => auth.requestCode(state.email!))}
                >
                  인증코드 다시 받기
                </button>
              </div>
            </form>
          )}
          {["provisioning", "paused", "action_required"].includes(
            phase ?? "",
          ) && (
            <div className="space-y-4 rounded-xl border border-[#E4E4E7] bg-[#F4F4F5] p-4 dark:border-[#27272A] dark:bg-[#18181B]">
              <p
                className="flex items-start gap-2 text-sm leading-6"
                role="status"
              >
                {phase === "provisioning" ? (
                  <LuLoaderCircle
                    className="mt-1 h-4 w-4 shrink-0 motion-safe:animate-spin"
                    aria-hidden
                  />
                ) : (
                  <LuCircleAlert
                    className="mt-1 h-4 w-4 shrink-0"
                    aria-hidden
                  />
                )}
                {phase === "action_required"
                  ? "서비스 연결에 운영자 확인이 필요합니다."
                  : phase === "paused"
                    ? "연결 준비가 잠시 멈췄습니다. 상태를 다시 확인해 주세요."
                    : "이메일 인증이 완료되었습니다. 서비스를 준비하고 있습니다."}
              </p>
              {state?.providers && (
                <dl className="space-y-2 border-t border-[#E4E4E7] pt-4 text-xs text-[#52525B] dark:border-[#27272A] dark:text-[#A1A1AA]">
                  {(["litellm", "maru"] as const).map((name) => (
                    <div key={name} className="flex justify-between gap-3">
                      <dt className="shrink-0">
                        {name === "litellm" ? "AI 서비스" : "문서 검색"}
                      </dt>
                      <dd className="break-all text-right">
                        {state.providers![name].needs_attention
                          ? "운영자 확인 필요"
                          : state.providers![name].status}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              {phase === "paused" && (
                <button
                  className={button}
                  onClick={() => act(() => auth.retry())}
                >
                  발급 상태 다시 확인
                </button>
              )}
            </div>
          )}
          {phase === "activating" && (
            <p className="flex items-center gap-2 text-sm" role="status">
              <LuLoaderCircle
                className="h-4 w-4 motion-safe:animate-spin"
                aria-hidden
              />
              개인 작업 공간을 열고 있습니다.
            </p>
          )}
          {phase === "signing_out" && (
            <p
              className="mt-8 flex items-center gap-2 text-sm leading-6"
              role="status"
            >
              <LuLoaderCircle
                className="h-4 w-4 shrink-0 motion-safe:animate-spin"
                aria-hidden
              />
              작업을 종료하고 로그인 정보를 정리하고 있습니다.
            </p>
          )}
          {(state?.message || error) && (
            <p
              className="mt-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300"
              role="alert"
            >
              <LuCircleAlert className="mt-1 h-4 w-4 shrink-0" aria-hidden />
              <span>{error || state?.message}</span>
            </p>
          )}
          {state &&
            !["signed_out", "activating", "signing_out"].includes(
              state.phase,
            ) && (
              <div className="mt-6 border-t border-[#E4E4E7] pt-4 text-center dark:border-[#27272A]">
                <button
                  className={secondaryButton}
                  onClick={() => act(() => auth.logout())}
                >
                  <LuArrowLeft className="h-3.5 w-3.5" aria-hidden />
                  다른 이메일로 로그인
                </button>
              </div>
            )}
        </section>
      </div>
    </main>
  );
}
