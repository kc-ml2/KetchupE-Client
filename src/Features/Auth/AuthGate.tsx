import { useEffect, useMemo, useState, type PropsWithChildren } from "react";
import { useNavigate } from "react-router-dom";
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
  const api = useMemo(() => state?.sessionId ? auth?.agent(state.sessionId) : null, [auth, state?.sessionId]);
  const account = useMemo(() => auth && state?.email ? { email: state.email, logout: () => auth.logout() } : null, [auth, state?.email]);

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
      if (next.phase === "ready" || next.phase === "signed_out") navigate("/agent", { replace: true });
    });
    void auth.getState().then((next) => { if (live && !changed) setState(next); }).catch(() => { if (live) setError("로그인 상태를 확인하지 못했습니다. 앱을 다시 실행해 주세요."); });
    return () => { live = false; unsubscribe(); };
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
    void action().catch(() => setError("요청을 처리하지 못했습니다. 다시 시도해 주세요."));
  };

  if (!auth) return <main className="grid h-screen place-items-center p-8">케찹이 데스크톱 앱에서 사내 이메일로 로그인해 주세요.</main>;
  if (state?.phase === "ready" && api) return (
    <AgentApiContext.Provider key={state.sessionId} value={api}>
      <AccountContext.Provider value={account}>
        <div className="h-screen">{children}</div>
      </AccountContext.Provider>
    </AgentApiContext.Provider>
  );

  const phase = state?.phase;
  const enteringCode = phase === "code" || phase === "verifying";
  const requesting = phase === "requesting";
  const remaining = Math.max(0, Math.ceil((Date.parse(state?.expiresAt ?? "") - now) / 1000));
  const field = "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-zinc-900 focus:outline-blue-600 disabled:opacity-50";
  const button = "w-full rounded-lg bg-blue-600 px-4 py-2 font-medium text-white disabled:opacity-50";
  return (
    <main className="grid min-h-screen place-items-center bg-zinc-50 p-6 text-zinc-900">
      <section className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-7 shadow-sm" aria-labelledby="login-title">
        <h1 id="login-title" className="text-2xl font-semibold">케찹이 로그인</h1>
        <p className="mb-6 mt-2 text-sm text-zinc-600">사내 이메일로 인증하고 업무를 시작하세요.</p>
        {!state && <p role="status">로그인 상태를 확인하고 있습니다.</p>}
        {(phase === "signed_out" || requesting) && (
          <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); act(() => auth.requestCode(email)); }}>
            <label className="block space-y-2"><span className="text-sm">사내 이메일</span><input className={field} type="email" autoComplete="email" required maxLength={254} value={email} disabled={requesting} onChange={(event) => setEmail(event.target.value)} /></label>
            <button className={button} disabled={requesting}>{requesting ? "인증코드 요청 중…" : "인증코드 받기"}</button>
          </form>
        )}
        {enteringCode && state && (
          <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); act(() => auth.verifyCode(code)); }}>
            <p className="break-all text-sm">{state.email}로 보낸 코드를 입력하세요.</p>
            <label className="block space-y-2"><span className="text-sm">6자리 인증코드</span><input className={field} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} disabled={phase === "verifying"} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} /></label>
            <p className="text-xs text-zinc-500">{remaining ? `남은 시간 ${Math.floor(remaining / 60)}분 ${remaining % 60}초` : "코드가 만료되었습니다. 다시 요청해 주세요."}</p>
            <button className={button} disabled={phase === "verifying" || !remaining}>{phase === "verifying" ? "확인 중…" : "인증하기"}</button>
            <button type="button" className="text-sm underline" disabled={phase === "verifying"} onClick={() => act(() => auth.requestCode(state.email!))}>인증코드 다시 받기</button>
          </form>
        )}
        {["provisioning", "paused", "action_required"].includes(phase ?? "") && (
          <div className="space-y-4">
            <p role="status">{phase === "action_required" ? "서비스 키 발급에 운영자 확인이 필요합니다." : "이메일 인증이 완료되었습니다. 서비스를 준비하고 있습니다."}</p>
            {state?.providers && <dl className="space-y-2 text-sm">{(["litellm", "maru"] as const).map((name) => <div key={name} className="flex justify-between gap-3"><dt>{name === "litellm" ? "LiteLLM" : "MARU"}</dt><dd>{state.providers![name].needs_attention ? "운영자 확인 필요" : state.providers![name].status}</dd></div>)}</dl>}
            {phase === "paused" && <button className={button} onClick={() => act(() => auth.retry())}>발급 상태 다시 확인</button>}
          </div>
        )}
        {phase === "activating" && <p role="status">개인 작업 공간을 열고 있습니다.</p>}
        {phase === "signing_out" && <p role="status">작업을 종료하고 로그인 정보를 정리하고 있습니다.</p>}
        {(state?.message || error) && <p className="mt-4 text-sm text-red-700" role="alert">{error || state?.message}</p>}
        {state && !["signed_out", "activating", "signing_out"].includes(state.phase) && <button className="mt-5 text-sm text-zinc-600 underline" onClick={() => act(() => auth.logout())}>다른 이메일로 로그인</button>}
      </section>
    </main>
  );
}
