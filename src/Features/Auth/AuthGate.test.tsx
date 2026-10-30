import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import AuthGate from "./AuthGate";
import type { AuthAPI, AuthState } from "@app-types/Auth.types";
import type { KetchupEAgentAPI } from "@app-types/Agent.types";
import { useAgentApi } from "@Features/Agent/hooks/useAgentApi";
import { useContext } from "react";
import { AccountContext } from "@Contexts/AccountContext";

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
  function Private() {
    const current = useAgentApi();
    const account = useContext(AccountContext);
    return <div>{current === api ? "private account" : "wrong API"}<span>{account?.email}</span><button onClick={() => void account?.logout()}>로그아웃</button></div>;
  }
  render(<MemoryRouter><AuthGate><Private /></AuthGate></MemoryRouter>);
  expect(await screen.findByLabelText("사내 이메일")).toBeInTheDocument();
  expect(screen.getByText("이메일").closest("li")).toHaveAttribute("aria-current", "step");
  expect(screen.queryByText("private account")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("사내 이메일"), { target: { value: "a@kct.co.kr" } });
  fireEvent.click(screen.getByText("인증코드 받기"));
  expect(auth.requestCode).toHaveBeenCalledWith("a@kct.co.kr");
  act(() => emit({ phase: "code", email: "a@kct.co.kr", expiresAt: new Date(Date.now() + 300000).toISOString() }));
  expect(screen.getByRole("heading", { name: "메일함을 확인해 주세요" })).toBeInTheDocument();
  expect(screen.getByText("코드 확인").closest("li")).toHaveAttribute("aria-current", "step");
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

it("shows expiry, resend feedback, and recovery while preparing the workspace", async () => {
  let emit!: (state: AuthState) => void;
  const requestCode = vi.fn().mockRejectedValue(new Error("offline"));
  const retry = vi.fn().mockResolvedValue(undefined);
  const logout = vi.fn().mockResolvedValue(undefined);
  window.authAPI = {
    getState: vi.fn().mockResolvedValue({ phase: "code", email: "a@kct.co.kr", expiresAt: new Date(Date.now() - 1000).toISOString() }),
    onChange: (listener) => { emit = listener; return () => undefined; },
    requestCode, retry, logout,
    verifyCode: vi.fn().mockResolvedValue(undefined), agent: vi.fn(),
  };
  render(<MemoryRouter><AuthGate>private</AuthGate></MemoryRouter>);
  expect(await screen.findByLabelText("6자리 인증코드")).toHaveAccessibleDescription("코드가 만료되었습니다. 다시 요청해 주세요.");
  expect(screen.getByRole("button", { name: "인증하기" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "인증코드 다시 받기" }));
  expect(requestCode).toHaveBeenCalledWith("a@kct.co.kr");
  expect(await screen.findByRole("alert")).toHaveTextContent("요청을 처리하지 못했습니다. 다시 시도해 주세요.");
  act(() => emit({ phase: "verifying", email: "a@kct.co.kr", expiresAt: new Date(Date.now() + 300000).toISOString() }));
  expect(screen.getByLabelText("6자리 인증코드")).toBeDisabled();
  expect(screen.getByRole("button", { name: "확인 중…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "인증코드 다시 받기" })).toBeDisabled();
  act(() => emit({ phase: "paused", email: "a@kct.co.kr" }));
  expect(screen.getByText("작업 공간").closest("li")).toHaveAttribute("aria-current", "step");
  expect(screen.getByRole("status")).toHaveTextContent("연결 준비가 잠시 멈췄습니다.");
  fireEvent.click(screen.getByRole("button", { name: "발급 상태 다시 확인" }));
  expect(retry).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "다른 이메일로 로그인" }));
  expect(logout).toHaveBeenCalledOnce();
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
