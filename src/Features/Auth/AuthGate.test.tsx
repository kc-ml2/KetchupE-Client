import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import AuthGate from "./AuthGate";
import type { AuthAPI, AuthState } from "@app-types/Auth.types";
import type { KetchupEAgentAPI } from "@app-types/Agent.types";
import { useAgentApi } from "@Features/Agent/hooks/useAgentApi";

afterEach(() => { delete window.authAPI; });

it("gates private children, submits leading-zero codes, and remounts a bound API on account changes", async () => {
  let emit!: (state: AuthState) => void;
  const api = { listThreads: vi.fn() } as unknown as KetchupEAgentAPI;
  const auth: AuthAPI = {
    getState: vi.fn().mockResolvedValue({ phase: "signed_out" }), requestCode: vi.fn().mockResolvedValue(undefined),
    verifyCode: vi.fn().mockResolvedValue(undefined), retry: vi.fn().mockResolvedValue(undefined), logout: vi.fn().mockResolvedValue(undefined),
    onChange: (listener) => { emit = listener; return () => undefined; }, agent: vi.fn().mockReturnValue(api),
  };
  window.authAPI = auth;
  function Private() { const current = useAgentApi(); return <div>{current === api ? "private account" : "wrong API"}</div>; }
  render(<MemoryRouter><AuthGate><Private /></AuthGate></MemoryRouter>);
  expect(await screen.findByLabelText("사내 이메일")).toBeInTheDocument();
  expect(screen.queryByText("private account")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("사내 이메일"), { target: { value: "a@kct.co.kr" } });
  fireEvent.click(screen.getByText("인증코드 받기"));
  expect(auth.requestCode).toHaveBeenCalledWith("a@kct.co.kr");
  act(() => emit({ phase: "code", email: "a@kct.co.kr", expiresAt: new Date(Date.now() + 300000).toISOString() }));
  fireEvent.change(screen.getByLabelText("6자리 인증코드"), { target: { value: "012345" } });
  fireEvent.click(screen.getByText("인증하기"));
  expect(auth.verifyCode).toHaveBeenCalledWith("012345");
  act(() => emit({ phase: "ready", email: "a@kct.co.kr", sessionId: "session-a" }));
  expect(screen.getByText("private account")).toBeInTheDocument();
  expect(auth.agent).toHaveBeenCalledWith("session-a");
  fireEvent.click(screen.getByText("로그아웃"));
  await waitFor(() => expect(auth.logout).toHaveBeenCalled());
  act(() => emit({ phase: "signing_out" }));
  expect(screen.queryByText("private account")).not.toBeInTheDocument();
  act(() => emit({ phase: "ready", email: "b@kct.co.kr", sessionId: "session-b" }));
  expect(auth.agent).toHaveBeenCalledWith("session-b");
  expect(screen.queryByText("a@kct.co.kr")).not.toBeInTheDocument();
});

it("ignores an initial state response that arrives after a newer auth event", async () => {
  let emit!: (state: AuthState) => void;
  let finish!: (state: AuthState) => void;
  window.authAPI = {
    getState: () => new Promise((resolve) => { finish = resolve; }),
    onChange: (listener) => { emit = listener; return () => undefined; },
  } as AuthAPI;
  render(<MemoryRouter><AuthGate>private</AuthGate></MemoryRouter>);
  act(() => emit({ phase: "action_required", message: "운영자 확인 필요" }));
  await act(async () => { finish({ phase: "signed_out" }); });
  expect(screen.getByText("운영자 확인 필요")).toBeInTheDocument();
  expect(screen.queryByLabelText("사내 이메일")).not.toBeInTheDocument();
});
